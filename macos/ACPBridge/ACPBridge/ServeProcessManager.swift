import Foundation

enum ServeError: Error, Equatable, LocalizedError {
    /// `:8787` answered but the health fingerprint didn't match ours — some
    /// other process owns the port. We never silently rebind elsewhere.
    case portOccupiedByOther(String)
    case bundledExecutableMissing
    case launchFailed(String)
    case healthTimeout
    /// The `/health` request itself failed in a way that isn't a plain
    /// "nothing is listening" connection failure and isn't a successful
    /// response with a mismatched product either — e.g. a decode failure or
    /// an unexpected HTTP status. We don't know if that's our server or a
    /// foreign one, so we surface it distinctly instead of guessing.
    case healthCheckFailed(String)

    var errorDescription: String? {
        switch self {
        case .portOccupiedByOther(let detail):
            return "Port 8787 is already in use by another process (\(detail)). Stop it and relaunch ACP Bridge."
        case .bundledExecutableMissing:
            return "Could not find the bundled acp-serve executable next to ACPBridge."
        case .launchFailed(let reason):
            return "Failed to launch acp-serve: \(reason)"
        case .healthTimeout:
            return "acp-serve did not become healthy in time."
        case .healthCheckFailed(let detail):
            return "Health check on port 8787 failed unexpectedly (\(detail))."
        }
    }
}

/// Pure decision logic extracted from `ServeProcessManager` so it can be unit
/// tested without spawning processes or hitting the network.
enum ServeDecision: Equatable {
    case reuse
    case spawn
    case failure(ServeError)
}

enum ServeDecisionMaker {
    static func decide(healthResult: Result<Health, Error>, expectedProduct: String = ProductInfo.identifier) -> ServeDecision {
        switch healthResult {
        case .success(let health):
            if health.product == expectedProduct {
                return .reuse
            }
            return .failure(.portOccupiedByOther(health.product))
        case .failure(let error):
            if isConnectionFailure(error) {
                return .spawn
            }
            // A response came back but wasn't a clean success — e.g. a
            // decode failure or unexpected HTTP status. That's not evidence
            // of a *foreign* server (which would decode fine, just with a
            // different product), so don't conflate it with
            // `portOccupiedByOther`.
            return .failure(.healthCheckFailed(error.localizedDescription))
        }
    }

    /// True when `error` indicates nothing is listening on the port (so we
    /// should spawn our own server), as opposed to a foreign server having
    /// answered with an unexpected/invalid response.
    static func isConnectionFailure(_ error: Error) -> Bool {
        let nsError = error as NSError
        guard nsError.domain == NSURLErrorDomain else { return false }
        switch nsError.code {
        case NSURLErrorCannotConnectToHost,
             NSURLErrorCannotFindHost,
             NSURLErrorNetworkConnectionLost,
             NSURLErrorTimedOut,
             NSURLErrorNotConnectedToInternet:
            return true
        default:
            return false
        }
    }
}

/// Lifecycle of the managed `acp-serve` process, published so any view can
/// render it — the window is only one possible observer, and may never open.
enum ServeState: Equatable {
    case idle
    case launching
    case ready
    case failed(String)
}

@MainActor
final class ServeProcessManager: ObservableObject {
    @Published private(set) var isRunning = false
    @Published private(set) var state: ServeState = .idle

    private var process: Process?
    private let apiClient: ApiClient
    private let fileManager: FileManager
    private let bundle: Bundle
    private let healthTimeout: TimeInterval

    init(
        apiClient: ApiClient = ApiClient(),
        fileManager: FileManager = .default,
        bundle: Bundle = .main,
        healthTimeout: TimeInterval = 8
    ) {
        self.apiClient = apiClient
        self.fileManager = fileManager
        self.bundle = bundle
        self.healthTimeout = healthTimeout
    }

    /// Idempotent, non-throwing entry point that publishes progress through
    /// `state`. Owned by `AppDelegate` so a menu-bar-only launch (no window,
    /// or the window closed) still starts the server; the window's Retry
    /// button and `ContentView.task` call the same thing.
    ///
    /// If we already believe the server is `.ready` but `/health` no longer
    /// answers (serve crashed, was killed, or died with a suspended debug
    /// session), clear the stale state and spawn again — otherwise the
    /// Observatory WebView stays blank forever.
    func start() async {
        switch state {
        case .launching:
            return
        case .ready:
            if await isOurServeHealthy() {
                return
            }
            clearManagedProcess()
            state = .launching
        case .idle, .failed:
            state = .launching
        }
        do {
            try await ensureRunning()
            state = .ready
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    /// 1. GET /health. 2. Connection failure → spawn acp-serve. 3. Matching
    /// product fingerprint → reuse. 4. Otherwise → throw portOccupiedByOther.
    func ensureRunning() async throws {
        let result: Result<Health, Error>
        do {
            result = .success(try await apiClient.health())
        } catch {
            result = .failure(error)
        }

        switch ServeDecisionMaker.decide(healthResult: result) {
        case .reuse:
            isRunning = true
            return
        case .failure(let error):
            throw error
        case .spawn:
            break
        }

        try spawnServe()
        try await waitForHealth()
        isRunning = true
    }

    /// Terminates `acp-serve` only if this manager spawned it. Never touches
    /// an `acp-bridge` process — those are owned by Xcode over stdio.
    func shutdown() {
        defer { state = .idle }
        guard let process, process.isRunning else {
            clearManagedProcess()
            return
        }
        // Clear handler first so our unexpected-exit path doesn't fire on Quit.
        process.terminationHandler = nil
        process.terminate()
        process.waitUntilExit()
        clearManagedProcess()
    }

    private func spawnServe() throws {
        guard let executableURL = bundle.executableURL else {
            throw ServeError.bundledExecutableMissing
        }
        let macOSDir = executableURL.deletingLastPathComponent()
        let serveURL = macOSDir.appendingPathComponent("acp-serve")
        guard fileManager.isExecutableFile(atPath: serveURL.path) else {
            throw ServeError.bundledExecutableMissing
        }

        let resourcesURL = bundle.resourceURL ?? macOSDir.deletingLastPathComponent().appendingPathComponent("Resources")
        let home = try ensureApplicationSupportHome()
        let configPath = home.appendingPathComponent("acp-bridge.config.json")
        if !fileManager.fileExists(atPath: configPath.path) {
            let defaultConfig = resourcesURL.appendingPathComponent("acp-bridge.config.default.json")
            if fileManager.fileExists(atPath: defaultConfig.path) {
                try fileManager.copyItem(at: defaultConfig, to: configPath)
            }
        }

        let process = Process()
        process.executableURL = serveURL
        let overrides = [
            "ACP_BRIDGE_HOME": home.path,
            "ACP_BRIDGE_CONFIG": configPath.path,
            "ACP_BRIDGE_RESOURCES": resourcesURL.path,
        ]
        // Merge onto the inherited environment (PATH, HOME, etc.) rather than
        // replacing it — acp-serve still needs a usable PATH/HOME to run.
        process.environment = ProcessInfo.processInfo.environment.merging(overrides) { _, override in override }
        process.terminationHandler = { [weak self] terminated in
            Task { @MainActor in
                self?.handleServeExited(terminated)
            }
        }
        do {
            try process.run()
        } catch {
            throw ServeError.launchFailed(error.localizedDescription)
        }
        self.process = process
    }

    private func handleServeExited(_ terminated: Process) {
        guard process === terminated else { return }
        clearManagedProcess()
        switch state {
        case .ready, .launching:
            state = .failed("acp-serve exited unexpectedly (status \(terminated.terminationStatus)).")
        case .idle, .failed:
            break
        }
    }

    private func clearManagedProcess() {
        process = nil
        isRunning = false
    }

    private func isOurServeHealthy() async -> Bool {
        guard let health = try? await apiClient.health() else { return false }
        return health.product == ProductInfo.identifier
    }

    private func ensureApplicationSupportHome() throws -> URL {
        let base = try fileManager.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let home = base.appendingPathComponent("ACP Bridge", isDirectory: true)
        try fileManager.createDirectory(at: home, withIntermediateDirectories: true)
        let dataDir = home.appendingPathComponent("data", isDirectory: true)
        try fileManager.createDirectory(at: dataDir, withIntermediateDirectories: true)
        return home
    }

    private func waitForHealth(pollInterval: TimeInterval = 0.2) async throws {
        let deadline = Date().addingTimeInterval(healthTimeout)
        while Date() < deadline {
            if await isOurServeHealthy() {
                return
            }
            try await Task.sleep(nanoseconds: UInt64(pollInterval * 1_000_000_000))
        }
        throw ServeError.healthTimeout
    }
}
