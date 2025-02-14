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

// Health check endpoint for Render
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Rate limiting
const connections = new Map();
const MAX_CONNECTIONS_PER_IP = 50;
const RATE_LIMIT_WINDOW = 60000; // 1 minute

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

// Store connected users
const rooms = new Map();

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join-room', (roomId) => {
        // Sanitize roomId
        const safeRoomId = roomId.replace(/[^a-zA-Z0-9-]/g, '');
        
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
    });

    socket.on('offer', ({ target, description }) => {
        io.to(target).emit('offer', {
            offerer: socket.id,
            description
        });
    });

    socket.on('answer', ({ target, description }) => {
        io.to(target).emit('answer', {
            answerer: socket.id,
            description
        });
    });


    socket.on('ice-candidate', ({ target, candidate }) => {
        io.to(target).emit('ice-candidate', {
            sender: socket.id,
            candidate
        });
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        // Remove user from all rooms and notify others
        rooms.forEach((users, roomId) => {
            if (users.has(socket.id)) {
                users.delete(socket.id);
                io.to(roomId).emit('user-disconnected', socket.id);
            }
        });
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});