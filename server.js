// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
const allowedOrigins = [
  "https://ziplan.vercel.app", // replace with actual Vercel URL
  "http://localhost:19006",          // Expo web dev
  "http://localhost:3000"      // (optional) local web dev
];

app.use(cors({
  origin: function (origin, callback) {
    // allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    } else {
      return callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
}));

app.use(express.json());

// ---------------- HEALTH CHECK ----------------
app.get("/", (req, res) => {
  res.send("✅ Backend is running!");
});

// ---------------- MONGO CONNECTION ----------------
mongoose
  .connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

// ---------------- MONGO MODELS ----------------
const recipeSchema = new mongoose.Schema({
  ingredients: [String],
  recipeText: String,
  createdAt: { type: Date, default: Date.now },
});

const preferencesSchema = new mongoose.Schema({
  dietary: [String],
  equipment: [String],
  budget: Number,
  cookingHours: Number,
  mealTimes: Object,
  createdAt: { type: Date, default: Date.now },
});

const userSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true },
  passwordHash: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

const Recipe = mongoose.model("Recipe", recipeSchema);
const UserPreference = mongoose.model("UserPreference", preferencesSchema);
const User = mongoose.model("User", userSchema);

// ---------------- ROUTES ----------------

// Test route
app.get("/api/test", (req, res) => {
  console.log("✅ /api/test was hit");
  res.json({ success: true, message: "Server is working!" });
});

// ---------------- AUTH ROUTES ----------------

// Signup
app.post("/api/signup", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, message: "Email and password required" });

    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ success: false, message: "Email already in use" });

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const newUser = new User({ email, passwordHash });
    await newUser.save();

    const token = jwt.sign({ id: newUser._id }, process.env.JWT_SECRET, { expiresIn: "7d" });
    res.json({ success: true, token });
  } catch (error) {
    console.error("❌ /api/signup error:", error);
    res.status(500).json({ success: false, message: "Server error during signup" });
  }
});

// Login
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, message: "Email and password required" });

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ success: false, message: "Invalid credentials" });

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) return res.status(400).json({ success: false, message: "Invalid credentials" });

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "7d" });
    res.json({ success: true, token });
  } catch (error) {
    console.error("❌ /api/login error:", error);
    res.status(500).json({ success: false, message: "Server error during login" });
  }
});

// ---------------- PREFERENCES ----------------
app.post("/api/preferences", async (req, res) => {
  try {
    const { dietary, equipment, budget, cookingHours, mealTimes } = req.body;

    if (!dietary || !equipment || budget == null || cookingHours == null) {
      return res.status(400).json({ success: false, message: "Invalid preferences data" });
    }

    const prefs = new UserPreference({ dietary, equipment, budget, cookingHours, mealTimes });
    await prefs.save();

    res.json({ success: true, message: "Preferences saved!" });
  } catch (error) {
    console.error("❌ Error saving preferences:", error);
    res.status(500).json({ success: false, message: "Server error saving preferences" });
  }
});

// ---------------- AI RECIPE GENERATOR ----------------
app.post("/api/recipe", async (req, res) => {
  try {
    const { ingredients } = req.body;
    if (!ingredients || !Array.isArray(ingredients)) {
      return res.status(400).json({ success: false, message: "Ingredients must be an array" });
    }

    const prefs = await UserPreference.findOne().sort({ createdAt: -1 });

    const prompt = `
Generate a recipe using these ingredients: ${ingredients.join(", ")}.
Consider these preferences: 
- Dietary: ${prefs?.dietary?.join(", ") || "None"}
- Equipment available: ${prefs?.equipment?.join(", ") || "Any"}
- Weekly budget: $${prefs?.budget || "flexible"}
- Cooking hours per week: ${prefs?.cookingHours || "flexible"}
- Meal times: ${JSON.stringify(prefs?.mealTimes || {})}

Include a title, clear ingredients list, and step-by-step instructions.
`;

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-4o-mini", input: prompt }),
    });

    const data = await response.json();
    console.log("⬅ OpenAI response:", JSON.stringify(data, null, 2));

    const recipeText = data.output?.[0]?.content?.[0]?.text || "No recipe generated.";

    const newRecipe = new Recipe({ ingredients, recipeText });
    await newRecipe.save();

    res.json({ success: true, recipe: recipeText });
  } catch (error) {
    console.error("❌ Server error in /api/recipe:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

// ---------------- PROFILE UPDATES ----------------

// Update Email
app.post("/api/update-email", async (req, res) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ success: false, message: "Unauthorized" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { email } = req.body;

    if (!email || !email.includes("@")) {
      return res.status(400).json({ success: false, message: "Invalid email" });
    }

    // Check if email already exists
    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(400).json({ success: false, message: "Email already in use" });
    }

    await User.findByIdAndUpdate(decoded.id, { email });
    res.json({ success: true, message: "Email updated successfully" });
  } catch (error) {
    console.error("❌ /api/update-email error:", error);
    res.status(500).json({ success: false, message: "Server error updating email" });
  }
});

// Update Password
app.post("/api/update-password", async (req, res) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ success: false, message: "Unauthorized" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { password } = req.body;

    if (!password || password.length < 6) {
      return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    await User.findByIdAndUpdate(decoded.id, { passwordHash });
    res.json({ success: true, message: "Password updated successfully" });
  } catch (error) {
    console.error("❌ /api/update-password error:", error);
    res.status(500).json({ success: false, message: "Server error updating password" });
  }
});


// ---------------- START SERVER ----------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
