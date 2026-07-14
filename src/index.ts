import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

import authRoutes from './routes/authRoutes';
import adminRoutes from './routes/adminRoutes';
import zoneRoutes from './routes/zoneRoutes';
import rateCardRoutes from './routes/rateCardRoutes';
import orderRoutes from './routes/orderRoutes';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Set up CORS using the FRONTEND_URL environment variable (supports comma-separated list of origins)
const allowedOrigins = process.env.FRONTEND_URL 
  ? process.env.FRONTEND_URL.split(',').map(o => o.trim()) 
  : ['http://localhost:5173'];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like curl, postman, mobile apps)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) !== -1 || allowedOrigins.includes('*')) {
      return callback(null, true);
    } else {
      return callback(new Error('Not allowed by CORS'), false);
    }
  },
  credentials: true
}));

app.use(express.json());

// Routes registration
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin/zones', zoneRoutes);
app.use('/api/admin/rate-cards', rateCardRoutes);
app.use('/api/orders', orderRoutes);

// A simple Hello World route to verify CORS connection
app.get('/api/hello', (req, res) => {
  res.json({ message: "Hello from Last-Mile Delivery Backend!" });
});

// Root check route
app.get('/', (req, res) => {
  res.send('Last-Mile Delivery Backend API is online.');
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`[Backend] Server running on port ${PORT}`);
    console.log(`[Backend] CORS allowed origins: ${allowedOrigins.join(', ')}`);
  });
}

export default app;
