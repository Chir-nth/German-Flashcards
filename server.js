require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ─── MongoDB ──────────────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/deutsch_lernen';
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB connected to:', MONGO_URI))
  .catch(err => { console.error('❌ MongoDB error:', err.message); process.exit(1); });

// ─── Schemas ──────────────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  username:     { type: String, required: true, unique: true, trim: true, lowercase: true },
  displayName:  { type: String, required: true, trim: true },
  passwordHash: { type: String, required: true },
  createdAt:    { type: Date, default: Date.now }
});

const cardSchema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  word:       { type: String, required: true, trim: true },
  translation:{ type: String, required: true, trim: true },
  sentenceDe: { type: String, trim: true, default: '' },
  sentenceEn: { type: String, trim: true, default: '' },
  createdAt:  { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Card = mongoose.model('Card', cardSchema);

// ─── Auth middleware ──────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'deutsch_lernen_jwt_secret';

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ─── Register ─────────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, displayName, password } = req.body;
    if (!username || !displayName || !password)
      return res.status(400).json({ error: 'All fields are required' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const clean = username.toLowerCase().trim();
    if (await User.findOne({ username: clean }))
      return res.status(409).json({ error: 'Username already taken' });

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({ username: clean, displayName: displayName.trim(), passwordHash });
    console.log('✅ Registered:', user.username);

    const token = jwt.sign(
      { id: user._id.toString(), username: user.username, displayName: user.displayName },
      JWT_SECRET, { expiresIn: '30d' }
    );
    res.json({ token, user: { id: user._id, username: user.username, displayName: user.displayName } });
  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Login ────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'Username and password are required' });

    const clean = username.toLowerCase().trim();
    console.log('🔐 Login attempt:', clean);

    const user = await User.findOne({ username: clean });
    if (!user) {
      const all = await User.find({}, 'username');
      console.log('❌ User not found. Existing users:', all.map(u => u.username));
      return res.status(401).json({ error: 'Username not found' });
    }

    console.log('👤 Found user:', user.username, '| hash present:', !!user.passwordHash);
    const valid = await bcrypt.compare(password, user.passwordHash);
    console.log('🔑 Password match:', valid);

    if (!valid)
      return res.status(401).json({ error: 'Incorrect password' });

    const token = jwt.sign(
      { id: user._id.toString(), username: user.username, displayName: user.displayName },
      JWT_SECRET, { expiresIn: '30d' }
    );
    res.json({ token, user: { id: user._id, username: user.username, displayName: user.displayName } });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Cards ────────────────────────────────────────────────────────────────────
app.get('/api/cards', auth, async (req, res) => {
  try {
    const cards = await Card.find({ userId: req.user.id }).sort({ createdAt: -1 });
    res.json(cards);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/cards', auth, async (req, res) => {
  try {
    const { word, translation, sentenceDe, sentenceEn } = req.body;
    if (!word || !translation)
      return res.status(400).json({ error: 'Word and translation are required' });
    const card = await Card.create({
      userId: req.user.id, word, translation,
      sentenceDe: sentenceDe || '', sentenceEn: sentenceEn || ''
    });
    res.json(card);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/cards/:id', auth, async (req, res) => {
  try {
    const card = await Card.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
    if (!card) return res.status(404).json({ error: 'Card not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Translate proxy (MyMemory — free, no API key needed) ────────────────────
app.post('/api/translate', auth, async (req, res) => {
  try {
    const { text, direction } = req.body;
    if (!text) return res.status(400).json({ error: 'Text is required' });

    const langPair = direction === 'en-de' ? 'en|de' : 'de|en';
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.trim())}&langpair=${langPair}`;

    const response = await fetch(url);
    const data = await response.json();

    const translation = data.responseData?.translatedText || '';
    res.json({ translation });
  } catch (err) {
    console.error('Translate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Fallback to frontend ─────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Running at http://localhost:${PORT}`));
