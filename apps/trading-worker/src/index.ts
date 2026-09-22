// signal listeners alone do not keep Node alive; the timer does, until shutdown clears it
const keepAlive = setInterval(() => {}, 60_000);

function stop(): void {
  clearInterval(keepAlive);
}

process.once('SIGTERM', stop);
process.once('SIGINT', stop);

console.log('trading-worker placeholder started');
