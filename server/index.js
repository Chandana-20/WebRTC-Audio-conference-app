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
            ? "https://webrtc-audio-conference-call.onrender.com"  // No trailing slash
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

// Serve static files from public directory
app.use(express.static(path.join(__dirname, '../public')));

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Rate limiting configuration
const connections = new Map();
const MAX_CONNECTIONS_PER_IP = 50;
const RATE_LIMIT_WINDOW = 60000; // 1 minute

// Rate limiting middleware
app.use((req, res, next) => {
    const ip = req.ip;
    const now = Date.now();
    
    if (!connections.has(ip)) {
        connections.set(ip, []);
    }
    
    const reqs = connections.get(ip);
    const recentReqs = reqs.filter(time => now - time < RATE_LIMIT_WINDOW);
    
    if (recentReqs.length >= MAX_CONNECTIONS_PER_IP) {
        return res.status(429).send('Too many requests');
    }
    
    reqs.push(now);
    connections.set(ip, recentReqs);
    next();
});

// Store room information
const rooms = new Map();


io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    
    let currentRoom = null;

    socket.on('join-room', (roomId) => {
        try {
            // Sanitize roomId
            const safeRoomId = roomId.replace(/[^a-zA-Z0-9-]/g, '');
            
            // Leave current room if any
            if (currentRoom) {
                handleLeaveRoom();
            }
            
            currentRoom = safeRoomId;
            socket.join(safeRoomId);
            
            if (!rooms.has(safeRoomId)) {
                rooms.set(safeRoomId, new Set());
            }
            
            rooms.get(safeRoomId).add(socket.id);
            
            // Notify others in the room
            socket.to(safeRoomId).emit('user-connected', socket.id);
            
            // Send list of existing users to the new participant
            const users = Array.from(rooms.get(safeRoomId));
            socket.emit('existing-users', users);
            
            // Log room state
            console.log(`User ${socket.id} joined room ${safeRoomId}`);
            console.log(`Room ${safeRoomId} users:`, users);
            
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
            
            if (roomUsers.size === 0) {
                rooms.delete(currentRoom);
            }
            
            socket.to(currentRoom).emit('user-disconnected', socket.id);
            socket.leave(currentRoom);
            
            console.log(`User ${socket.id} left room ${currentRoom}`);
            currentRoom = null;
        }
    }

    // WebRTC signaling
    socket.on('offer', ({ target, description }) => {
        try {
            if (!isValidTarget(target)) return;
            
            io.to(target).emit('offer', {
                offerer: socket.id,
                description
            });
            
            console.log(`Offer sent from ${socket.id} to ${target}`);
        } catch (error) {
            console.error('Error in offer handling:', error);
        }
    });

    socket.on('answer', ({ target, description }) => {
        try {
            if (!isValidTarget(target)) return;
            
            io.to(target).emit('answer', {
                answerer: socket.id,
                description
            });
            
            console.log(`Answer sent from ${socket.id} to ${target}`);
        } catch (error) {
            console.error('Error in answer handling:', error);
        }
    });

    socket.on('ice-candidate', ({ target, candidate }) => {
        try {
            if (!isValidTarget(target)) return;
            
            io.to(target).emit('ice-candidate', {
                sender: socket.id,
                candidate
            });
        } catch (error) {
            console.error('Error in ice-candidate handling:', error);
        }
    });

    function isValidTarget(target) {
        if (!currentRoom || !rooms.has(currentRoom)) {
            console.warn(`Invalid room state for user ${socket.id}`);
            return false;
        }
        
        const roomUsers = rooms.get(currentRoom);
        if (!roomUsers.has(target)) {
            console.warn(`Target ${target} not found in room ${currentRoom}`);
            return false;
        }
        
        return true;
    }

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        handleLeaveRoom();
    });
});

// Cleanup old rate limit entries periodically
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
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
