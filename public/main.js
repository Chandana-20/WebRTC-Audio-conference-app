class AudioConference {
    constructor() {
        this.socket = io(undefined, {
            reconnection: true,
            reconnectionAttempts: 5,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            timeout: 20000,
            transports: ['websocket'],
        });

        this.peers = new Map();
        this.localStream = null;
        this.roomId = null;
        this.isMuted = false;
        this.isConnecting = false;

        this.rtcConfig = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'turn:your.turn.server:3478', username: 'user', credential: 'password' } // Use a TURN server
            ],
            iceCandidatePoolSize: 10,
            iceTransportPolicy: 'all',
            bundlePolicy: 'max-bundle'
        };

        this.initializeDOMElements();
        this.bindEventListeners();
        this.setupSocketListeners();
    }

    initializeDOMElements() {
        this.joinBtn = document.getElementById('joinBtn');
        this.leaveBtn = document.getElementById('leaveBtn');
        this.muteBtn = document.getElementById('muteBtn');
        this.roomInput = document.getElementById('roomId');
        this.participantsDiv = document.getElementById('participants');
    }

    bindEventListeners() {
        this.joinBtn.onclick = this.debounce(() => this.joinRoom(), 1000);
        this.leaveBtn.onclick = () => this.leaveRoom();
        this.muteBtn.onclick = () => this.toggleMute();
        window.addEventListener('beforeunload', () => this.cleanup());
    }

    setupSocketListeners() {
        this.socket.on('connect', () => {
            console.log('Connected to server');
            this.isConnecting = false;
        });

        this.socket.on('user-connected', async (userId) => {
            console.log('User connected:', userId);
            await this.connectToNewUser(userId);
        });

        this.socket.on('user-disconnected', (userId) => this.handleUserDisconnection(userId));

        this.socket.on('existing-users', async (users) => {
            console.log('Existing users:', users);
            for (const userId of users) {
                if (userId !== this.socket.id) {
                    await this.connectToNewUser(userId);
                }
            }
        });

        this.setupWebRTCSignaling();
    }

     // 🔹 ADD THIS FUNCTION BELOW ⬇️
    debounce(func, wait) {
        let timeout;
        return (...args) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), wait);
        };
    }

    setupWebRTCSignaling() {
        this.socket.on('offer', async ({ offerer, description }) => {
            try {
                let peerConnection = this.peers.get(offerer) || this.createPeerConnection(offerer);

                if (!peerConnection.remoteDescription) {
                    await peerConnection.setRemoteDescription(new RTCSessionDescription(description));
                }

                const answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer);

                this.socket.emit('answer', { target: offerer, description: answer });
            } catch (error) {
                console.error('Error handling offer:', error);
            }
        });

        this.socket.on('answer', async ({ answerer, description }) => {
            try {
                const peerConnection = this.peers.get(answerer);
                if (!peerConnection) {
                    console.warn('Received answer for non-existent peer:', answerer);
                    return;
                }

                if (peerConnection.signalingState === "stable") {
                    console.warn(`Ignoring duplicate answer from ${answerer}`);
                    return;
                }

                await peerConnection.setRemoteDescription(new RTCSessionDescription(description));
                console.log("Remote description set successfully for:", answerer);
            } catch (error) {
                console.error('Error handling answer:', error);
            }
        });

        this.socket.on('ice-candidate', async ({ sender, candidate }) => {
            try {
                const peerConnection = this.peers.get(sender);
                if (!peerConnection) {
                    console.warn('Received ICE candidate for non-existent peer:', sender);
                    return;
                }

                if (peerConnection.remoteDescription && peerConnection.localDescription) {
                    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                } else {
                    console.warn('Queued ICE candidate for later processing:', sender);
                    peerConnection.queuedCandidates = peerConnection.queuedCandidates || [];
                    peerConnection.queuedCandidates.push(candidate);
                }
            } catch (error) {
                console.error('Error handling ICE candidate:', error);
            }
        });
    }

    async joinRoom() {
        if (this.isConnecting) return;
        this.isConnecting = true;

        try {
            this.roomId = this.roomInput.value.trim() || 'default-room';

            this.localStream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                video: false
            });

            this.socket.emit('join-room', this.roomId);
            this.updateUIForJoin();
            this.addParticipant(this.socket.id, true);
        } catch (error) {
            console.error('Error joining room:', error);
            this.isConnecting = false;
        }
    }

    async leaveRoom() {
        await this.cleanup();
        this.updateUIForLeave();
    }

    async cleanup() {
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }

        this.peers.forEach(connection => {
            connection.close();
            this.removeParticipant(connection.userId);
        });
        this.peers.clear();

        if (this.roomId) {
            this.socket.emit('leave-room', this.roomId);
            this.roomId = null;
        }
    }

    createPeerConnection(userId) {
        const peerConnection = new RTCPeerConnection(this.rtcConfig);
        peerConnection.userId = userId;
        peerConnection.queuedCandidates = [];

        peerConnection.onconnectionstatechange = () => {
            console.log(`Connection state for peer ${userId}:`, peerConnection.connectionState);
            if (peerConnection.connectionState === 'failed') {
                this.handleConnectionFailure(userId);
            }
        };

        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                this.socket.emit('ice-candidate', { target: userId, candidate: event.candidate });
            }
        };

        peerConnection.ontrack = (event) => this.handleIncomingTrack(event, userId);

        this.peers.set(userId, peerConnection);
        return peerConnection;
    }

    async connectToNewUser(userId) {
        try {
            if (this.peers.has(userId)) {
                this.peers.get(userId).close();
                this.peers.delete(userId);
            }

            const peerConnection = this.createPeerConnection(userId);
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);

            this.socket.emit('offer', { target: userId, description: offer });
            this.addParticipant(userId, false);
        } catch (error) {
            console.error('Error connecting to new user:', error);
        }
    }

    handleConnectionFailure(userId) {
        console.log(`Attempting to reconnect to peer ${userId}`);
        if (this.peers.has(userId)) {
            this.peers.get(userId).close();
            this.peers.delete(userId);
        }

        setTimeout(() => this.connectToNewUser(userId), 2000);
    }

    handleUserDisconnection(userId) {
        console.log('User disconnected:', userId);
        if (this.peers.has(userId)) {
            this.peers.get(userId).close();
            this.peers.delete(userId);
        }
        this.removeParticipant(userId);
    }
}

window.addEventListener('load', () => {
    new AudioConference();
});
