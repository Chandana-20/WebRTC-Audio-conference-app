// server.js
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const mediasoup = require("mediasoup");

const app = express();
const server = http.createServer(app);

// In your server initialization:
// Define mediasoupSettings
const mediasoupSettings = {
  worker: {
    rtcMinPort: 10000,
    rtcMaxPort: 10100,
  },
  router: {
    mediaCodecs: [
      {
        kind: "audio",
        mimeType: "audio/opus",
        clockRate: 48000,
        channels: 2,
      },
    ],
  },
};

// Initialize MediaSoup worker
async function initializeMediaSoup() {
  state.worker = await mediasoup.createWorker({
    logLevel: "warn",
    rtcMinPort: mediasoupSettings.worker.rtcMinPort,
    rtcMaxPort: mediasoupSettings.worker.rtcMaxPort,
  });

  state.router = await state.worker.createRouter({
    mediaCodecs: mediasoupSettings.router.mediaCodecs,
  });

  console.log("📡 MediaSoup worker and router initialized");
}

// Store for our app state
const state = {
  worker: null,
  router: null,
  rooms: new Map(), // roomId -> { transports, producers, consumers }
  peers: new Map(), // socketId -> { roomId, transports, producers, consumers }
};

// Initialize MediaSoup worker
async function initializeMediaSoup() {
  state.worker = await mediasoup.createWorker({
    logLevel: "warn",
    rtcMinPort: mediasoupSettings.worker.rtcMinPort,
    rtcMaxPort: mediasoupSettings.worker.rtcMaxPort,
  });

  state.router = await state.worker.createRouter({
    mediaCodecs: mediasoupSettings.router.mediaCodecs,
  });

  console.log("📡 MediaSoup worker and router initialized");
}

// Initialize server
async function initializeServer() {
  await initializeMediaSoup();

  // Basic security headers
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    next();
  });

  // Serve static files
  app.use(express.static(path.join(__dirname, "public")));

  // Socket.io setup with CORS
  const io = new Server(server, {
    cors: {
      origin:
        process.env.NODE_ENV === "production"
          ? "https://webrtc-audio-conference-app.onrender.com"
          : "http://localhost:3000",
    },
  });

  // Handle WebSocket connections
  io.on("connection", handleConnection);

  // Start server
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
}

// Handle new WebSocket connections
async function handleConnection(socket) {
  console.log(`🔗 New connection: ${socket.id}`);

  // Initialize peer state
  state.peers.set(socket.id, {
    roomId: null,
    transports: new Map(),
    producers: new Map(),
    consumers: new Map(),
  });

  // Handle join room request
  socket.on("joinRoom", async ({ roomId }, callback) => {
    try {
      const peer = state.peers.get(socket.id);
      peer.roomId = roomId;

      // Create room if it doesn't exist
      if (!state.rooms.has(roomId)) {
        state.rooms.set(roomId, {
          transports: new Map(),
          producers: new Map(),
          consumers: new Map(),
        });
      }

      // Get router RTP capabilities
      const routerRtpCapabilities = state.router.rtpCapabilities;

      callback({ rtpCapabilities: routerRtpCapabilities });

      // Notify others in room
      socket.join(roomId);
      socket.to(roomId).emit("peerJoined", { peerId: socket.id });
    } catch (error) {
      console.error("Error joining room:", error);
      callback({ error: error.message });
    }
  });

  // Handle transport creation
  socket.on("createTransport", async ({ direction }, callback) => {
    try {
      const transport = await createWebRtcTransport();
      const peer = state.peers.get(socket.id);

      peer.transports.set(direction, transport);

      callback({
        params: {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        },
      });
    } catch (error) {
      callback({ error: error.message });
    }
  });

  // Handle transport connection
  socket.on(
    "connectTransport",
    async ({ direction, dtlsParameters }, callback) => {
      try {
        const peer = state.peers.get(socket.id);
        const transport = peer.transports.get(direction);

        await transport.connect({ dtlsParameters });
        callback({ success: true });
      } catch (error) {
        callback({ error: error.message });
      }
    }
  );

  // Handle producer creation (publishing audio)
  socket.on(
    "produce",
    async ({ transportId, kind, rtpParameters }, callback) => {
      try {
        const peer = state.peers.get(socket.id);
        const transport = peer.transports.get("send");

        const producer = await transport.produce({
          kind,
          rtpParameters,
        });

        peer.producers.set(producer.id, producer);

        // Notify others to consume this new producer
        socket.to(peer.roomId).emit("newProducer", {
          producerId: producer.id,
          producerPeerId: socket.id,
        });

        callback({ id: producer.id });
      } catch (error) {
        callback({ error: error.message });
      }
    }
  );

  // Handle consumer creation (receiving audio)
  socket.on("consume", async ({ producerId }, callback) => {
    try {
      const peer = state.peers.get(socket.id);
      const transport = peer.transports.get("recv");

      const consumer = await transport.consume({
        producerId,
        rtpCapabilities: state.router.rtpCapabilities,
      });

      peer.consumers.set(consumer.id, consumer);

      callback({
        id: consumer.id,
        producerId: producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      });
    } catch (error) {
      callback({ error: error.message });
    }
  });

  // Handle disconnection
  socket.on("disconnect", () => {
    console.log(`🔌 Peer disconnected: ${socket.id}`);
    const peer = state.peers.get(socket.id);

    if (peer) {
      // Clean up peer's resources
      peer.producers.forEach((producer) => producer.close());
      peer.consumers.forEach((consumer) => consumer.close());
      peer.transports.forEach((transport) => transport.close());

      // Notify others in the room
      if (peer.roomId) {
        socket.to(peer.roomId).emit("peerLeft", { peerId: socket.id });
      }

      state.peers.delete(socket.id);
    }
  });
}

// Helper function to create WebRTC transport
async function createWebRtcTransport() {
  return await state.router.createWebRtcTransport({
    listenIps: [
      {
        ip: process.env.LISTEN_IP || "0.0.0.0",
        announcedIp: process.env.ANNOUNCED_IP || "127.0.0.1",
      },
    ],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
  });
}

// Start the server
initializeServer().catch((error) => {
  console.error("Failed to initialize server:", error);
  process.exit(1);
});
