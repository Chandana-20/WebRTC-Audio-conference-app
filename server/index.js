const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from public directory
app.use(express.static(path.join(__dirname, '../public')));

// Store connected users
const rooms = new Map();

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join-room', (roomId) => {
        socket.join(roomId);
        
        if (!rooms.has(roomId)) {
            rooms.set(roomId, new Set());
        }
        rooms.get(roomId).add(socket.id);

        // Notify others in the room
        socket.to(roomId).emit('user-connected', socket.id);
        
        // Send list of existing users to the new participant
        const users = Array.from(rooms.get(roomId));
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});