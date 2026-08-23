export class EventHub {
  private clients = new Set<ReadableStreamDefaultController<string>>();

  publishNamed(eventName: string, record: unknown): void {
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(record)}\n\n`;
    for (const client of [...this.clients]) {
      try {
        client.enqueue(payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  subscribe(): ReadableStream<string> {
    let controller: ReadableStreamDefaultController<string> | undefined;
    return new ReadableStream<string>({
      start: (c) => {
        controller = c;
        this.clients.add(c);
      },
      cancel: () => {
        if (controller) {
          this.clients.delete(controller);
        }
      },
    });
  }
}
