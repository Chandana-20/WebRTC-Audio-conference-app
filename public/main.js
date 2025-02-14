class AudioConference {
    constructor() {
        // Configure Socket.IO for production
        const socketOptions = {
            reconnection: true,
            reconnectionAttempts: 5,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            timeout: 20000,
            transports: ['websocket'], // Explicitly specify transport
        };

        this.socket = io(undefined, socketOptions);
        this.peers = new Map(); // Store RTCPeerConnection objects
        this.localStream = null;
        this.roomId = null;
        this.isMuted = false;
        this.isConnecting = false; // Add connection state tracking

        // Enhanced ICE server configuration
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

        // Initialize DOM elements with null checks
        this.initializeDOMElements();
        
        // Bind event listeners
        this.bindEventListeners();
        
        // Setup socket listeners
        this.setupSocketListeners();
    }

    initializeDOMElements() {
        this.joinBtn = document.getElementById('joinBtn');
        this.leaveBtn = document.getElementById('leaveBtn');
        this.muteBtn = document.getElementById('muteBtn');
        this.roomInput = document.getElementById('roomId');
        this.participantsDiv = document.getElementById('participants');

        // Validate DOM elements
        if (!this.joinBtn || !this.leaveBtn || !this.muteBtn || 
            !this.roomInput || !this.participantsDiv) {
            throw new Error('Required DOM elements not found');
        }
    }

    bindEventListeners() {
        // Debounce join room clicks to prevent multiple rapid attempts
        this.joinBtn.onclick = this.debounce(() => this.joinRoom(), 1000);
        this.leaveBtn.onclick = () => this.leaveRoom();
        this.muteBtn.onclick = () => this.toggleMute();

        // Add window unload handler
        window.addEventListener('beforeunload', () => this.cleanup());
    }

    debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    setupSocketListeners() {
        // Basic socket connection handlers
        this.socket.on('connect', () => {
            console.log('Connected to server');
            this.isConnecting = false;
        });

        this.socket.on('connect_error', (error) => {
            console.error('Connection error:', error);
            this.handleError('Failed to connect to the server. Please try again later.');
        });

        this.socket.on('connect_timeout', () => {
            console.error('Connection timeout');
            this.handleError('Connection timeout. Please check your internet connection.');
        });

        // Room event handlers
        this.socket.on('user-connected', async (userId) => {
            try {
                console.log('User connected:', userId);
                await this.connectToNewUser(userId);
            } catch (error) {
                console.error('Error connecting to new user:', error);
                this.handleError('Failed to connect to new participant');
            }
        });

        this.socket.on('user-disconnected', (userId) => {
            this.handleUserDisconnection(userId);
        });

        this.socket.on('existing-users', async (users) => {
            try {
                console.log('Existing users:', users);
                for (const userId of users) {
                    if (userId !== this.socket.id) {
                        await this.connectToNewUser(userId);
                    }
                }
            } catch (error) {
                console.error('Error connecting to existing users:', error);
                this.handleError('Failed to connect to existing participants');
            }
        });

        // WebRTC signaling handlers
        this.setupWebRTCSignaling();
    }

    setupWebRTCSignaling() {
        this.socket.on('offer', async ({ offerer, description }) => {
            try {
                const peerConnection = this.createPeerConnection(offerer);
                await peerConnection.setRemoteDescription(new RTCSessionDescription(description));
                const answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer);
                this.socket.emit('answer', {
                    target: offerer,
                    description: answer
                });
            } catch (error) {
                console.error('Error handling offer:', error);
                this.handleError('Failed to process connection offer');
            }
        });

        this.socket.on('answer', async ({ answerer, description }) => {
            try {
                const peerConnection = this.peers.get(answerer);
                if (peerConnection) {
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

    async joinRoom() {
        if (this.isConnecting) return;
        this.isConnecting = true;

        try {
            this.roomId = this.roomInput.value.trim() || 'default-room';
            
            // Request audio with specific constraints
            this.localStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                },
                video: false
            });

            this.socket.emit('join-room', this.roomId);
            
            // Update UI
            this.updateUIForJoin();
            
            // Add local participant
            this.addParticipant(this.socket.id, true);
            
        } catch (error) {
            console.error('Error joining room:', error);
            this.handleError('Could not join room. Please check your microphone permissions.');
            this.isConnecting = false;
        }
    }

    updateUIForJoin() {
        this.joinBtn.disabled = true;
        this.leaveBtn.disabled = false;
        this.muteBtn.disabled = false;
        this.roomInput.disabled = true;
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

        // Close all peer connections
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

    updateUIForLeave() {
        this.joinBtn.disabled = false;
        this.leaveBtn.disabled = true;
        this.muteBtn.disabled = true;
        this.roomInput.disabled = false;
        this.participantsDiv.innerHTML = '';
        this.isConnecting = false;
    }

    toggleMute() {
        if (this.localStream) {
            const audioTrack = this.localStream.getAudioTracks()[0];
            if (audioTrack) {
                this.isMuted = !this.isMuted;
                audioTrack.enabled = !this.isMuted;
                this.muteBtn.textContent = this.isMuted ? 'Unmute' : 'Mute';
                this.muteBtn.classList.toggle('bg-yellow-500');
            }
        }
    }

    createPeerConnection(userId) {
        const peerConnection = new RTCPeerConnection(this.rtcConfig);
        peerConnection.userId = userId; // Store userId for reference

        this.setupPeerConnectionHandlers(peerConnection, userId);
        this.addLocalStreamTracks(peerConnection);

        this.peers.set(userId, peerConnection);
        return peerConnection;
    }

    setupPeerConnectionHandlers(peerConnection, userId) {
        peerConnection.onconnectionstatechange = () => {
            console.log(`Connection state for peer ${userId}:`, peerConnection.connectionState);
            if (peerConnection.connectionState === 'failed') {
                this.handleConnectionFailure(userId);
            }
        };

        peerConnection.oniceconnectionstatechange = () => {
            console.log(`ICE connection state for peer ${userId}:`, peerConnection.iceConnectionState);
            if (peerConnection.iceConnectionState === 'failed') {
                this.handleIceFailure(userId);
            }
        };

        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                this.socket.emit('ice-candidate', {
                    target: userId,
                    candidate: event.candidate
                });
            }
        };

        peerConnection.ontrack = (event) => {
            this.handleIncomingTrack(event, userId);
        };
    }

    addLocalStreamTracks(peerConnection) {
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => {
                peerConnection.addTrack(track, this.localStream);
            });
        }
    }

    handleIncomingTrack(event, userId) {
        const existingAudio = document.getElementById(`audio-${userId}`);
        if (!existingAudio) {
            const audio = document.createElement('audio');
            audio.id = `audio-${userId}`;
            audio.srcObject = event.streams[0];
            audio.autoplay = true;
            document.body.appendChild(audio);
        }
    }

    async handleConnectionFailure(userId) {
        console.log(`Attempting to reconnect to peer ${userId}`);
        if (this.peers.has(userId)) {
            const oldConnection = this.peers.get(userId);
            oldConnection.close();
            this.peers.delete(userId);
            await this.connectToNewUser(userId);
        }
    }

    handleIceFailure(userId) {
        console.log(`ICE connection failed for peer ${userId}`);
        this.handleConnectionFailure(userId);
    }

    handleUserDisconnection(userId) {
        console.log('User disconnected:', userId);
        if (this.peers.has(userId)) {
            this.peers.get(userId).close();
            this.peers.delete(userId);
        }
        this.removeParticipant(userId);
    }

    async connectToNewUser(userId) {
        try {
            const peerConnection = this.createPeerConnection(userId);
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            
            this.socket.emit('offer', {
                target: userId,
                description: offer
            });

            this.addParticipant(userId, false);
        } catch (error) {
            console.error('Error connecting to new user:', error);
            this.handleError('Failed to establish connection with new participant');
        }
    }

    addParticipant(userId, isLocal) {
        const participantDiv = document.createElement('div');
        participantDiv.id = `participant-${userId}`;
        participantDiv.className = 'flex items-center space-x-2 p-2 bg-gray-50 rounded';
        participantDiv.innerHTML = `
            <div class="w-3 h-3 rounded-full ${isLocal ? 'bg-green-500' : 'bg-blue-500'}"></div>
            <span>${isLocal ? 'You' : `Participant ${userId.slice(0, 4)}`}</span>
        `;
        this.participantsDiv.appendChild(participantDiv);
    }

    removeParticipant(userId) {
        const participant = document.getElementById(`participant-${userId}`);
        if (participant) {
            participant.remove();
        }
        const audio = document.getElementById(`audio-${userId}`);
        if (audio) {
            audio.remove();
        }
    }

    handleError(message) {
        console.error(message);
        alert(message);
    }
}

// Initialize when the page loads
window.addEventListener('load', () => {
    try {
        new AudioConference();
    } catch (error) {
        console.error('Failed to initialize AudioConference:', error);
        alert('Failed to initialize the application. Please refresh the page.');
    }
});