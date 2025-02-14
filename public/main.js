class AudioConference {
    constructor() {
        const socketOptions = {
            reconnection: true,
            reconnectionAttempts: 5,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            timeout: 20000,
            transports: ['websocket'],
        };

        this.socket = io(undefined, socketOptions);
        this.peers = new Map();
        this.localStream = null;
        this.roomId = null;
        this.isMuted = false;
        this.isConnecting = false;

        this.rtcConfig = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' },
                { urls: 'stun:stun3.l.google.com:19302' },
                { urls: 'stun:stun4.l.google.com:19302' }
            ],
            iceCandidatePoolSize: 10,
            iceTransportPolicy: 'all',
            bundlePolicy: 'max-bundle'
        };

        this.initializeDOMElements();
        this.bindEventListeners();
        this.setupSocketListeners();
    }

    setupWebRTCSignaling() {
        this.socket.on('answer', async ({ answerer, description }) => {
            try {
                const peerConnection = this.peers.get(answerer);
                if (peerConnection) {
                    console.log("Current signaling state for", answerer, ":", peerConnection.signalingState);
                    
                    if (peerConnection.signalingState === "have-local-offer") {
                        await peerConnection.setRemoteDescription(new RTCSessionDescription(description));
                        console.log("Remote description set successfully for:", answerer);
                    } else {
                        console.warn("Skipping setRemoteDescription for", answerer, "invalid state:", peerConnection.signalingState);
                    }
                }
            } catch (error) {
                console.error('Error handling answer:', error);
                this.handleError('Failed to process connection answer');
            }
        });

        this.socket.on('offer', async ({ offerer, description }) => {
            try {
                const peerConnection = this.createPeerConnection(offerer);
                await peerConnection.setRemoteDescription(new RTCSessionDescription(description));
                const answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer);
                this.socket.emit('answer', { target: offerer, description: answer });
            } catch (error) {
                console.error('Error handling offer:', error);
            }
        });

        this.socket.on('ice-candidate', async ({ sender, candidate }) => {
            try {
                const peerConnection = this.peers.get(sender);
                if (peerConnection) {
                    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                }
            } catch (error) {
                console.error('Error handling ICE candidate:', error);
            }
        });
    }

    createPeerConnection(userId) {
        const peerConnection = new RTCPeerConnection(this.rtcConfig);
        this.peers.set(userId, peerConnection);
        return peerConnection;
    }
}
