// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(cors());
app.use(express.json());

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

const Recipe = mongoose.model("Recipe", recipeSchema);
const UserPreference = mongoose.model("UserPreference", preferencesSchema);

// ---------------- ROUTES ----------------

// Test route
app.get("/api/test", (req, res) => {
  console.log("✅ /api/test was hit");
  res.json({ success: true, message: "Server is working!" });
});

// Save user preferences
app.post("/api/preferences", async (req, res) => {
  try {
    const { dietary, equipment, budget, cookingHours, mealTimes } = req.body;

    if (!dietary || !equipment || budget == null || cookingHours == null) {
      return res.status(400).json({ success: false, message: "Invalid preferences data" });
    }

    // Save new preference document
    const prefs = new UserPreference({
      dietary,
      equipment,
      budget,
      cookingHours,
      mealTimes,
    });
    await prefs.save();

    res.json({ success: true, message: "Preferences saved!" });
  } catch (error) {
    console.error("❌ Error saving preferences:", error);
    res.status(500).json({ success: false, message: "Server error saving preferences" });
  }
});

// AI Recipe Generator (integrates preferences)
app.post("/api/recipe", async (req, res) => {
  try {
    const { ingredients } = req.body;
    if (!ingredients || !Array.isArray(ingredients)) {
      return res
        .status(400)
        .json({ success: false, message: "Ingredients must be an array" });
    }

    // ✅ Get latest preferences from DB
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
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: prompt,
      }),
    });

    const data = await response.json();
    console.log("⬅ OpenAI response:", JSON.stringify(data, null, 2));

    const recipeText =
      data.output?.[0]?.content?.[0]?.text || "No recipe generated.";

    // ✅ Save to MongoDB
    const newRecipe = new Recipe({ ingredients, recipeText });
    await newRecipe.save();

    res.json({ success: true, recipe: recipeText });
  } catch (error) {
    console.error("❌ Server error in /api/recipe:", error);
    res
      .status(500)
      .json({ success: false, message: "Server error", error: error.message });
  }
});

// ---------------- START SERVER ----------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});