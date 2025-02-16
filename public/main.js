// client.js
class AudioConference {
  constructor() {
    this.socket = io();
    this.device = null;
    this.sendTransport = null;
    this.recvTransport = null;
    this.producer = null;
    this.consumers = new Map();
    this.isConnected = false;

    // DOM elements
    this.joinBtn = document.getElementById("joinBtn");
    this.leaveBtn = document.getElementById("leaveBtn");
    this.muteBtn = document.getElementById("muteBtn");
    this.roomInput = document.getElementById("roomId");

    this.bindEvents();
  }

  bindEvents() {
    // UI events
    this.joinBtn.onclick = () => this.joinRoom();
    this.leaveBtn.onclick = () => this.leaveRoom();
    this.muteBtn.onclick = () => this.toggleMute();

    // Socket events
    this.socket.on("connect", () => {
      console.log("Connected to server");
      this.updateUI();
    });

    this.socket.on("disconnect", () => {
      console.log("Disconnected from server");
      this.isConnected = false;
      this.updateUI();
    });

    this.socket.on("peerJoined", ({ peerId }) => {
      console.log("Peer joined:", peerId);
      this.updateParticipants();
    });

    this.socket.on("peerLeft", ({ peerId }) => {
      console.log("Peer left:", peerId);
      this.removeConsumer(peerId);
      this.updateParticipants();
    });

    this.socket.on("newProducer", async ({ producerId, producerPeerId }) => {
      console.log("New producer:", producerId);
      await this.consumeAudio(producerId, producerPeerId);
    });
  }

  async joinRoom() {
    try {
      const roomId = this.roomInput.value.trim() || "default-room";

      // Get router RTP capabilities
      const { rtpCapabilities } = await this.request("joinRoom", { roomId });

      // Create mediasoup device
      this.device = new mediasoupClient.Device();
      await this.device.load({ routerRtpCapabilities: rtpCapabilities });

      // Create send transport
      await this.createTransport("send");

      // Create receive transport
      await this.createTransport("recv");

      // Get local media stream
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      // Create audio producer
      const track = stream.getAudioTracks()[0];
      this.producer = await this.sendTransport.produce({ track });

      this.isConnected = true;
      this.updateUI();
    } catch (error) {
      console.error("Error joining room:", error);
      alert("Failed to join room: " + error.message);
    }
  }

  async createTransport(direction) {
    // Create transport on server side
    const { params } = await this.request("createTransport", { direction });

    // Create local transport
    const transport =
      direction === "send"
        ? await this.device.createSendTransport(params)
        : await this.device.createRecvTransport(params);

    // Store transport
    if (direction === "send") {
      this.sendTransport = transport;
    } else {
      this.recvTransport = transport;
    }

    // Handle transport connection
    transport.on("connect", async ({ dtlsParameters }, callback, errback) => {
      try {
        await this.request("connectTransport", {
          direction,
          dtlsParameters,
        });
        callback();
      } catch (error) {
        errback(error);
      }
    });

    // Handle producer creation
    if (direction === "send") {
      transport.on(
        "produce",
        async ({ kind, rtpParameters }, callback, errback) => {
          try {
            const { id } = await this.request("produce", {
              transportId: transport.id,
              kind,
              rtpParameters,
            });
            callback({ id });
          } catch (error) {
            errback(error);
          }
        }
      );
    }
  }

  async consumeAudio(producerId, producerPeerId) {
    try {
      // Create consumer on server side
      const { id, kind, rtpParameters } = await this.request("consume", {
        producerId,
      });

      // Create local consumer
      const consumer = await this.recvTransport.consume({
        id,
        producerId,
        kind,
        rtpParameters,
      });

      // Store consumer
      this.consumers.set(producerPeerId, consumer);

      // Play the audio
      const mediaStream = new MediaStream([consumer.track]);
      const audioElement = new Audio();
      audioElement.srcObject = mediaStream;
      audioElement.play();
    } catch (error) {
      console.error("Error consuming audio:", error);
    }
  }

  async leaveRoom() {
    // Clean up producers
    if (this.producer) {
      this.producer.close();
      this.producer = null;
    }

    // Clean up consumers
    this.consumers.forEach((consumer) => consumer.close());
    this.consumers.clear();

    // Clean up transports
    if (this.sendTransport) {
      this.sendTransport.close();
      this.sendTransport = null;
    }
    if (this.recvTransport) {
      this.recvTransport.close();
      this.recvTransport = null;
    }

    this.isConnected = false;
    this.updateUI();
  }

  toggleMute() {
    if (this.producer) {
      this.producer.pause();
      this.muteBtn.textContent = this.producer.paused ? "Unmute" : "Mute";
    }
  }

  updateUI() {
    this.joinBtn.disabled = this.isConnected;
    this.leaveBtn.disabled = !this.isConnected;
    this.muteBtn.disabled = !this.isConnected;
    this.roomInput.disabled = this.isConnected;
  }

  // Helper function for socket.io requests
  request(type, data = {}) {
    return new Promise((resolve, reject) => {
      this.socket.emit(type, data, (response) => {
        if (response.error) {
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      });
    });
  }
}

// Initialize when page loads
window.addEventListener("load", () => {
  new AudioConference();
});
