const { io } = require('socket.io-client');

const SERVER_URL = 'http://localhost:3002';
const AUCTION_ID = '1634fe86-188a-4e15-9cbb-54bfe78e10c2';

// Driver token
const DRIVER_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiIxMDg4YmZkNS0wZTczLTQ4YjEtYjE3Ni04YTE4YjVjOTc0ZTEiLCJwaG9uZSI6IisyNTE5MjIyMjIyMjIiLCJyb2xlIjoiRFJJVkVSIiwiaWF0IjoxNzc0Mjg2ODg4LCJleHAiOjE3NzQ4OTE2ODh9.niZTOK08oibDaz-FFBEDQNwKjfXoKitINmcn0XXE61o';
const DRIVER_ID = '1088bfd5-0e73-48b1-b176-8a18b5c974e1';

console.log('Connecting to WebSocket server...');

const socket = io(SERVER_URL, {
  transports: ['websocket'],
  query: { token: DRIVER_TOKEN }
});

socket.on('connect', () => {
  console.log('✅ Connected to WebSocket server:', socket.id);

  // Join auction room
  console.log('Joining auction:', AUCTION_ID);
  socket.emit('join-auction', {
    auctionId: AUCTION_ID,
    userId: DRIVER_ID,
    role: 'DRIVER'
  });
});

socket.on('auction-state', (data) => {
  console.log('📊 Auction state received:', data);

  // Place a bid after receiving state
  setTimeout(() => {
    const newBid = (data.currentBid || data.startingBid || 15000) - 500;
    console.log(`Placing bid: ${newBid} ETB`);
    socket.emit('place-bid', {
      auctionId: AUCTION_ID,
      amount: newBid,
      userId: DRIVER_ID
    });
  }, 1000);
});

socket.on('new-bid', (data) => {
  console.log('🔨 New bid placed:', data);
});

socket.on('outbid-alert', (data) => {
  console.log('⚠️ Outbid alert:', data);
});

socket.on('user-joined', (data) => {
  console.log('👤 User joined:', data);
});

socket.on('user-left', (data) => {
  console.log('👋 User left:', data);
});

socket.on('auction-error', (data) => {
  console.error('❌ Auction error:', data);
});

socket.on('auction-won', (data) => {
  console.log('🏆 Auction won:', data);
});

socket.on('auction-ended', (data) => {
  console.log('🏁 Auction ended:', data);
});

socket.on('disconnect', () => {
  console.log('Disconnected from server');
});

socket.on('connect_error', (error) => {
  console.error('Connection error:', error.message);
});

// Keep script running for 10 seconds
setTimeout(() => {
  console.log('Leaving auction and disconnecting...');
  socket.emit('leave-auction', { auctionId: AUCTION_ID });
  socket.disconnect();
  process.exit(0);
}, 10000);
