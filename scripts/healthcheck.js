const http = require('http');

const port = process.env.PORT || 3000;
const host = '127.0.0.1';
const endpoint = `http://${host}:${port}/api/health`;

const request = http.get(endpoint, (response) => {
  if (response.statusCode >= 200 && response.statusCode < 400) {
    console.log(`Health check pass: ${response.statusCode}`);
    process.exit(0);
  }

  console.error(`Health check failed: ${response.statusCode}`);
  process.exit(1);
});

request.on('error', (error) => {
  console.error(`Health check error: ${error.message}`);
  process.exit(1);
});
