const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// Configure CORS for production
const io = new Server(server, {
    cors: {
        origin: process.env.NODE_ENV === 'production' 
            ? "https://webrtc-audio-conference-call.onrender.com"  
            : "http://localhost:3000",
        methods: ["GET", "POST"]
    }
});

// Security middleware
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
});

// Serve static files
app.use(express.static(path.join(__dirname, '../public')));

// Health check
app.get('/health', (req, res) => res.status(200).send('OK'));

// Rate limiting
const connections = new Map();
const MAX_CONNECTIONS_PER_IP = 50;
const RATE_LIMIT_WINDOW = 60000; 

app.use((req, res, next) => {
    const ip = req.ip;
    const now = Date.now();

    if (!connections.has(ip)) connections.set(ip, []);
    
    const reqs = connections.get(ip).filter(time => now - time < RATE_LIMIT_WINDOW);

    if (reqs.length >= MAX_CONNECTIONS_PER_IP) {
        return res.status(429).send('Too many requests');
    }

    reqs.push(now);
    connections.set(ip, reqs);
    next();
});

// Store room information
const rooms = new Map();

io.on('connection', (socket) => {
    console.log(`🔗 User connected: ${socket.id}`);
    
    let currentRoom = null;

    socket.on('join-room', (roomId) => {
        try {
            const safeRoomId = roomId.replace(/[^a-zA-Z0-9-]/g, '');

            if (currentRoom) handleLeaveRoom();
            
            currentRoom = safeRoomId;
            socket.join(safeRoomId);
            
            if (!rooms.has(safeRoomId)) rooms.set(safeRoomId, new Set());
            rooms.get(safeRoomId).add(socket.id);

            // Send existing users list
            const users = Array.from(rooms.get(safeRoomId));
            socket.emit('existing-users', users);
            
            // Notify others
            socket.to(safeRoomId).emit('user-connected', socket.id);

            console.log(`✅ User ${socket.id} joined room ${safeRoomId}`);
        } catch (error) {
            console.error('Error in join-room:', error);
            socket.emit('error', 'Failed to join room');
        }
    });

    socket.on('leave-room', handleLeaveRoom);

    function handleLeaveRoom() {
        if (currentRoom && rooms.has(currentRoom)) {
            const roomUsers = rooms.get(currentRoom);
            roomUsers.delete(socket.id);
            
            if (roomUsers.size === 0) rooms.delete(currentRoom);
            
            socket.to(currentRoom).emit('user-disconnected', socket.id);
            socket.leave(currentRoom);

            console.log(`❌ User ${socket.id} left room ${currentRoom}`);
            currentRoom = null;
        }
    }

    // WebRTC signaling

    socket.on('offer', ({ target, description }) => {
        if (!isValidTarget(target)) return;

        console.log(`📡 Offer sent from ${socket.id} to ${target}`);
        io.to(target).emit('offer', { offerer: socket.id, description });
    });

    socket.on('answer', ({ target, description }) => {
        if (!isValidTarget(target)) return;

        console.log(`📡 Answer sent from ${socket.id} to ${target}`);
        io.to(target).emit('answer', { answerer: socket.id, description });
    });

    socket.on('ice-candidate', ({ target, candidate }) => {
        if (!isValidTarget(target)) return;

        console.log(`❄️ ICE candidate from ${socket.id} to ${target}`);
        io.to(target).emit('ice-candidate', { sender: socket.id, candidate });
    });

    function isValidTarget(target) {
        if (!currentRoom || !rooms.has(currentRoom)) {
            console.warn(`⚠️ Invalid room state for user ${socket.id}`);
            return false;
        }
        const roomUsers = rooms.get(currentRoom);
        if (!roomUsers.has(target)) {
            console.warn(`⚠️ Target ${target} not in room ${currentRoom}`);
            return false;
        }
        return true;
    }

    socket.on('disconnect', () => {
        console.log(`🔌 User disconnected: ${socket.id}`);
        handleLeaveRoom();
    });
});

// Cleanup old rate limit entries
setInterval(() => {
    const now = Date.now();
    for (const [ip, reqs] of connections.entries()) {
        const recentReqs = reqs.filter(time => now - time < RATE_LIMIT_WINDOW);
        if (recentReqs.length === 0) {
            connections.delete(ip);
        } else {
            connections.set(ip, recentReqs);
        }
    }
}, RATE_LIMIT_WINDOW);

// Error handling
process.on('uncaughtException', (error) => console.error('🚨 Uncaught Exception:', error));
process.on('unhandledRejection', (reason, promise) => console.error('🚨 Unhandled Rejection:', reason));

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
