const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const dotenv = require('dotenv');


if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}


const app = express();
const NODE_ENV = process.env.NODE_ENV || 'development';
const PORT = Number(process.env.PORT) || 3000;
const JWT_SECRET = process.env.JWT_SECRET || (NODE_ENV === 'production' ? (() => {
  throw new Error('JWT_SECRET must be set in production.');
})() : 'dev-secret-change-me');
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const CORS_ORIGIN = (process.env.CORS_ORIGIN || 'http://localhost:3000,http://localhost:3001').split(',').map((value) => value.trim()).filter(Boolean);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'fuitos.db');
const UPLOAD_PATH = process.env.UPLOAD_PATH || path.join(__dirname, 'uploads');


fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(UPLOAD_PATH, { recursive: true });


let db;

function normalizeDatabaseUrl(rawUrl) {
  if (!rawUrl) return rawUrl;

  const [baseUrl, rawQuery = ''] = rawUrl.split('?');
  if (!rawQuery) return rawUrl;

  const searchParams = new URLSearchParams(rawQuery);
  searchParams.delete('sslmode');
  searchParams.delete('ssl');

  const cleanedQuery = searchParams.toString();
  return cleanedQuery ? baseUrl + '?' + cleanedQuery : baseUrl;
}

function toPostgresQuery(sql, params) {
  let index = 0;
