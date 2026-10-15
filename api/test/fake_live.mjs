// A stand-in for GPT-Live's socket endpoint, run as an auxiliary worker in the test runner: the seat
// under test connects to /live?id=X, the test to /test?id=X, and the relay passes text frames between
// them. Sockets must be made by a worker other than the one holding the seat, or workerd refuses the
// cross-context I/O; a worker of its own is the clean way.
export class Relay {
  constructor(state) {
    this.state = state;
    this.sides = { live: null, test: null };
    this.waiting = { live: [], test: [] };
  }

  fetch(request) {
    const url = new URL(request.url);
    const side = url.pathname === "/live" ? "live" : url.pathname === "/test" ? "test" : null;
    if (!side || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("not found", { status: 404 });
    }
    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept();
    this.sides[side] = server;
    const other = side === "live" ? "test" : "live";
    for (const frame of this.waiting[other]) {
      server.send(frame);
    }
    this.waiting[other] = [];
    server.addEventListener("message", (event) => {
      const peer = this.sides[other];
      if (peer) {
        peer.send(event.data);
      } else {
        this.waiting[side].push(event.data);
      }
    });
    server.addEventListener("close", () => {
      this.sides[side] = null;
      const peer = this.sides[other];
      if (peer) {
        peer.close(1000, "peer closed");
      }
    });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
}

export default {
  fetch(request, env) {
    const id = new URL(request.url).searchParams.get("id") ?? "default";
    return env.RELAY.get(env.RELAY.idFromName(id)).fetch(request);
  },
};
