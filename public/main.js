class AudioConference {
    constructor() {
        this.socket = io();
        this.peers = new Map(); // Store RTCPeerConnection objects
        this.localStream = null;
        this.roomId = null;
        this.isMuted = false;

        // DOM elements
        this.joinBtn = document.getElementById('joinBtn');
        this.leaveBtn = document.getElementById('leaveBtn');
        this.muteBtn = document.getElementById('muteBtn');
        this.roomInput = document.getElementById('roomId');
        this.participantsDiv = document.getElementById('participants');

        // Bind event listeners
        this.joinBtn.onclick = () => this.joinRoom();
        this.leaveBtn.onclick = () => this.leaveRoom();
        this.muteBtn.onclick = () => this.toggleMute();

        // Socket event handlers
        this.setupSocketListeners();
    }

    setupSocketListeners() {
        this.socket.on('user-connected', async (userId) => {
            console.log('User connected:', userId);
            await this.connectToNewUser(userId);
        });

        this.socket.on('user-disconnected', (userId) => {
            console.log('User disconnected:', userId);
            if (this.peers.has(userId)) {
                this.peers.get(userId).close();
                this.peers.delete(userId);
            }
            this.removeParticipant(userId);
        });

        this.socket.on('existing-users', async (users) => {
            console.log('Existing users:', users);
            for (const userId of users) {
                if (userId !== this.socket.id) {
                    await this.connectToNewUser(userId);
                }
            }
        });

        this.socket.on('offer', async ({ offerer, description }) => {
            const peerConnection = this.createPeerConnection(offerer);
            await peerConnection.setRemoteDescription(description);
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            this.socket.emit('answer', {
                target: offerer,
                description: answer
            });
        });

        this.socket.on('answer', async ({ answerer, description }) => {
            const peerConnection = this.peers.get(answerer);
            if (peerConnection) {
                await peerConnection.setRemoteDescription(description);
            }
        });

        this.socket.on('ice-candidate', async ({ sender, candidate }) => {
            const peerConnection = this.peers.get(sender);
            if (peerConnection) {
                await peerConnection.addIceCandidate(candidate);
            }
        });
    }

    async joinRoom() {
        try {
            this.roomId = this.roomInput.value || 'default-room';
            this.localStream = await navigator.mediaDevices.getUserMedia({ 
                audio: true, 
                video: false 
            });

            this.socket.emit('join-room', this.roomId);
            
            // Update UI
            this.joinBtn.disabled = true;
            this.leaveBtn.disabled = false;
            this.muteBtn.disabled = false;
            this.roomInput.disabled = true;
            
            // Add local participant
            this.addParticipant(this.socket.id, true);
            
        } catch (error) {
            console.error('Error joining room:', error);
            alert('Could not join room. Please check your microphone permissions.');
        }
    }

    async leaveRoom() {
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
        }

        // Close all peer connections
        this.peers.forEach(connection => connection.close());
        this.peers.clear();

        // Reset UI
        this.joinBtn.disabled = false;
        this.leaveBtn.disabled = true;
        this.muteBtn.disabled = true;
        this.roomInput.disabled = false;
        this.participantsDiv.innerHTML = '';
        this.roomId = null;
    }

    toggleMute() {
        if (this.localStream) {
            this.isMuted = !this.isMuted;
            this.localStream.getAudioTracks()[0].enabled = !this.isMuted;
            this.muteBtn.textContent = this.isMuted ? 'Unmute' : 'Mute';
            this.muteBtn.classList.toggle('bg-yellow-500');
        }
    }

    createPeerConnection(userId) {
        const peerConnection = new RTCPeerConnection({
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' }
            ]
        });

        // Add local stream
        this.localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, this.localStream);
        });

        // Handle ICE candidates
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                this.socket.emit('ice-candidate', {
                    target: userId,
                    candidate: event.candidate
                });
            }
        };

        // Handle incoming streams
        peerConnection.ontrack = (event) => {
            const audio = document.createElement('audio');
            audio.id = `audio-${userId}`;
            audio.srcObject = event.streams[0];
            audio.autoplay = true;
            document.body.appendChild(audio);
        };

        this.peers.set(userId, peerConnection);
        return peerConnection;
    }

    async connectToNewUser(userId) {
        const peerConnection = this.createPeerConnection(userId);
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        
        this.socket.emit('offer', {
            target: userId,
            description: offer
        });

        this.addParticipant(userId, false);
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
}

// Initialize when the page loads
window.addEventListener('load', () => {
    new AudioConference();
});