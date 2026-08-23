import Foundation

enum ServeError: Error, Equatable, LocalizedError {
    /// `:8787` answered but the health fingerprint didn't match ours — some
    /// other process owns the port. We never silently rebind elsewhere.
    case portOccupiedByOther(String)
    case bundledExecutableMissing
    case launchFailed(String)
    case healthTimeout

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
            return .failure(.portOccupiedByOther("unrecognized response: \(error.localizedDescription)"))
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

@MainActor
final class ServeProcessManager: ObservableObject {
    @Published private(set) var isRunning = false

    private var process: Process?
    private let apiClient: ApiClient
    private let fileManager: FileManager
    private let bundle: Bundle

    init(apiClient: ApiClient = ApiClient(), fileManager: FileManager = .default, bundle: Bundle = .main) {
        self.apiClient = apiClient
        self.fileManager = fileManager
        self.bundle = bundle
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
        guard let process, process.isRunning else {
            process = nil
            isRunning = false
            return
        }
        process.terminate()
        process.waitUntilExit()
        self.process = nil
        isRunning = false
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
        process.environment = [
            "ACP_BRIDGE_HOME": home.path,
            "ACP_BRIDGE_CONFIG": configPath.path,
            "ACP_BRIDGE_RESOURCES": resourcesURL.path,
        ]
        do {
            try process.run()
        } catch {
            throw ServeError.launchFailed(error.localizedDescription)
        }
        self.process = process
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

    private func waitForHealth(timeout: TimeInterval = 8, pollInterval: TimeInterval = 0.2) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let health = try? await apiClient.health(), health.product == ProductInfo.identifier {
                return
            }
            try await Task.sleep(nanoseconds: UInt64(pollInterval * 1_000_000_000))
        }
        throw ServeError.healthTimeout
    }
}
