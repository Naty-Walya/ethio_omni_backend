const { io } = require('socket.io-client');

const SERVER_URL = 'http://localhost:3002';
const AUCTION_ID = '1634fe86-188a-4e15-9cbb-54bfe78e10c2';

// Driver tokens
const DRIVER1_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiIxMDg4YmZkNS0wZTczLTQ4YjEtYjE3Ni04YTE4YjVjOTc0ZTEiLCJwaG9uZSI6IisyNTE5MjIyMjIyMjIiLCJyb2xlIjoiRFJJVkVSIiwiaWF0IjoxNzc0Mjg2ODg4LCJleHAiOjE3NzQ4OTE2ODh9.niZTOK08oibDaz-FFBEDQNwKjfXoKitINmcn0XXE61o';
const DRIVER1_ID = '1088bfd5-0e73-48b1-b176-8a18b5c974e1';

const DRIVER2_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiI4OWYyNGM1OS02ZjA4LTRlNDUtYWYzYS1kYWMyYmMwNjU1NjkiLCJwaG9uZSI6IisyNTE5MzMzMzMzMzMiLCJyb2xlIjoiRFJJVkVSIiwiaWF0IjoxNzc0Mjg2OTIwLCJleHAiOjE3NzQ4OTIxMjB9.-OJlgTVjN8m4eIkVjvPjy5XtC8q5zqV5q3eN23lIr9o';
const DRIVER2_ID = '89f24c59-6f08-4e45-af3a-dac2bc065569';

let driver1Socket, driver2Socket;

async function runTest() {
  console.log('=== Auction Completion Flow Test ===\n');
  console.log('Using existing auction:', AUCTION_ID);
  console.log('Auction will end in ~2 minutes\n');

  // Connect Driver 1
  driver1Socket = io(SERVER_URL, {
    transports: ['websocket'],
    query: { token: DRIVER1_TOKEN }
  });

  // Connect Driver 2
  driver2Socket = io(SERVER_URL, {
    transports: ['websocket'],
    query: { token: DRIVER2_TOKEN }
  });

  setupDriverEvents(driver1Socket, 'Driver1', DRIVER1_ID);
  setupDriverEvents(driver2Socket, 'Driver2', DRIVER2_ID);

  // Wait for connections
  await new Promise(r => setTimeout(r, 2000));

  // Join auction
  console.log('👥 Both drivers joining auction...\n');
  driver1Socket.emit('join-auction', {
    auctionId: AUCTION_ID,
    userId: DRIVER1_ID,
    role: 'DRIVER'
  });

  driver2Socket.emit('join-auction', {
    auctionId: AUCTION_ID,
    userId: DRIVER2_ID,
    role: 'DRIVER'
  });

  // Wait for state
  await new Promise(r => setTimeout(r, 2000));

  // Driver 1 places bid (must be lower than current 13000)
  console.log('🎯 Driver1 placing bid: 12500');
  driver1Socket.emit('place-bid', {
    auctionId: AUCTION_ID,
    amount: 12500,
    userId: DRIVER1_ID
  });

  await new Promise(r => setTimeout(r, 2000));

  // Driver 2 places lower bid
  console.log('🎯 Driver2 placing bid: 12000');
  driver2Socket.emit('place-bid', {
    auctionId: AUCTION_ID,
    amount: 12000,
    userId: DRIVER2_ID
  });

  await new Promise(r => setTimeout(r, 2000));

  // Driver 1 places even lower bid
  console.log('🎯 Driver1 placing bid: 11500');
  driver1Socket.emit('place-bid', {
    auctionId: AUCTION_ID,
    amount: 11500,
    userId: DRIVER1_ID
  });

  console.log('\n⏳ Waiting for auction to complete (40 seconds for server interval)...\n');

  // Wait for auction to end (server checks every 30 seconds)
  await new Promise(r => setTimeout(r, 40000));

  // Cleanup
  console.log('\n🧹 Cleaning up...');
  driver1Socket.emit('leave-auction', { auctionId: AUCTION_ID });
  driver2Socket.emit('leave-auction', { auctionId: AUCTION_ID });
  driver1Socket.disconnect();
  driver2Socket.disconnect();

  console.log('\n✅ Test complete');
  process.exit(0);
}

function setupDriverEvents(socket, name, driverId) {
  socket.on('connect', () => {
    console.log(`✅ ${name} connected:`, socket.id);
  });

  socket.on('auction-state', (data) => {
    console.log(`📊 ${name} received state:`, {
      currentBid: data.currentBid,
      bidCount: data.bidCount,
      endTime: data.endTime
    });
  });

  socket.on('new-bid', (data) => {
    console.log(`🔨 ${name} saw new bid:`, {
      driver: data.driverName,
      amount: data.amount,
      bidCount: data.bidCount
    });
  });

  socket.on('outbid-alert', (data) => {
    console.log(`⚠️ ${name} was outbid! New bid:`, data.amount);
  });

  socket.on('auction-won', (data) => {
    console.log(`\n🏆 ${name} received AUCTION WON:`, {
      winnerId: data.winnerId,
      winningAmount: data.winningAmount,
      auctionId: data.auctionId
    });
  });

  socket.on('auction-ended', (data) => {
    console.log(`\n🏁 ${name} received AUCTION ENDED:`, {
      auctionId: data.auctionId,
      message: data.message
    });
  });

  socket.on('auction-error', (error) => {
    console.error(`❌ ${name} error:`, error);
  });

  socket.on('disconnect', () => {
    console.log(`${name} disconnected`);
  });
}

runTest().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
