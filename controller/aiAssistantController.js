
const { randomUUID } = require("crypto");
const mongoose = require("mongoose");

const asyncHandler = require("../utils/asyncHandler");
const services = require("../services.config");
const AssistantChat = require("../model/assistantChat");
const ContentOs = require("../model/contentOs");

const {
  generateConversationalResponse,
  analyzeContentSeo,
  predictContentPerformance,
  generateHashtagMatrix,
  generateCreatorInsights,
} = require("../services/aiAssistantService");

// Configuration
const MAX_PROMPT_LENGTH = 5000;
const MAX_TITLE_LENGTH = 100;
const MAX_HISTORY_LENGTH = 20;
const DEFAULT_PLATFORM = "general";
const DEFAULT_TONE = "energetic";
const DEFAULT_LENGTH = "medium";

// Common helpers
const getUserId = (req) => req.user?.id || req.user?._id;

const ensureAuthenticated = (req, res) => {
  if (!getUserId(req)) {
    res.status(401).json({
      success: false,
      message: "Authentication required",
    });
    return false;
  }
  return true;
};

const validateObjectId = (id) =>
  mongoose.Types.ObjectId.isValid(id);

const validateText = (value, field = "Text", maxLength = MAX_PROMPT_LENGTH) => {
  if (typeof value !== "string" || !value.trim()) {
    return `${field} is required`;
  }

  if (value.length > maxLength) {
    return `${field} cannot exceed ${maxLength} characters`;
  }

  return null;
};

const successResponse = (res, data, message = "Success") =>
  res.status(200).json({
    success: true,
    message,
    data,
  });

const errorResponse = (res, status, message) =>
  res.status(status).json({
    success: false,
    message,
  });

// GET /services/ai-assistant
// Render AI Creator Assistant dashboard
const renderAssistantView = asyncHandler(async (req, res) => {
  const userId = getUserId(req);

  let chats = [];

  if (userId) {
    chats = await AssistantChat.find({ userId })
      .select("title platform tone length updatedAt")
      .sort({ updatedAt: -1 })
      .limit(20)
      .lean();
  }

  const initialInsights = generateCreatorInsights({
    niche: req.user?.bio || "Digital Creator",
  });

  res.render("ai-assistant", {
    title: "AI Creator Assistant - CreatorOS",
    activeNav: "ai-assistant",
    user: req.user || { name: "Creator" },
    services,
    chats,
    initialInsights,
    csrfToken: req.csrfToken ? req.csrfToken() : "",
  });
});

// POST /api/ai-assistant/chat
// Send conversational message
const sendMessage = asyncHandler(async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;

  const userId = getUserId(req);

  const {
    prompt,
    platform,
    tone,
    length,
    chatId,
  } = req.validatedBody || req.body;

  // Validate prompt
  const validationError = validateText(prompt, "Prompt");

  if (validationError) {
    return errorResponse(res, 400, validationError);
  }

  // Validate existing chat ID
  if (chatId && !validateObjectId(chatId)) {
    return errorResponse(res, 400, "Invalid chat ID");
  }

  let chatDoc;

  if (chatId) {
    chatDoc = await AssistantChat.findOne({
      _id: chatId,
      userId,
    });

    if (!chatDoc) {
      return errorResponse(res, 404, "Chat thread not found");
    }
  } else {
    const titleSnippet = prompt.trim().slice(0, 40);

    chatDoc = new AssistantChat({
      userId,
      title:
        titleSnippet +
        (prompt.trim().length > 40 ? "..." : ""),
      platform: platform || DEFAULT_PLATFORM,
      tone: tone || DEFAULT_TONE,
      length: length || DEFAULT_LENGTH,
      messages: [],
    });
  }

  const cleanPrompt = prompt.trim();

  // Add user message
  const userMessage = {
    messageId: `msg_${randomUUID()}`,
    role: "user",
    content: cleanPrompt,
    createdAt: new Date(),
  };

  chatDoc.messages.push(userMessage);

  // Keep recent conversation history for AI context
  const history = chatDoc.messages.slice(-MAX_HISTORY_LENGTH);

  // Generate AI response
  const aiResult = await generateConversationalResponse({
    prompt: cleanPrompt,
    platform: chatDoc.platform,
    tone: chatDoc.tone,
    length: length || chatDoc.length || DEFAULT_LENGTH,
    history,
  });

  if (!aiResult || typeof aiResult.content !== "string") {
    throw new Error("AI service returned an invalid response");
  }

  // Build assistant message
  const assistantMessage = {
    messageId: `msg_${randomUUID()}`,
    role: "assistant",
    content: aiResult.content,
    structuredData: {
      suggestions: aiResult.suggestions || [],
      seoScore: aiResult.seoScore ?? null,
      viralityScore: aiResult.viralityScore ?? null,
      keywords: aiResult.keywords || [],
      hashtags: aiResult.hashtags || [],
      ctas: aiResult.ctas || [],
    },
    createdAt: new Date(),
  };

  chatDoc.messages.push(assistantMessage);

  await chatDoc.save();

  return successResponse(
    res,
    {
      chatId: chatDoc._id,
      title: chatDoc.title,
      message: assistantMessage,
    },
    "Message generated successfully"
  );
});

// GET /api/ai-assistant/chats
// Get current user's chat threads
const getChats = asyncHandler(async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;

  const chats = await AssistantChat.find({
    userId: getUserId(req),
  })
    .select("title platform tone length updatedAt")
    .sort({ updatedAt: -1 })
    .limit(100)
    .lean();

  return successResponse(res, chats);
});

// GET /api/ai-assistant/chats/:id
// Get individual chat conversation
const getChatById = asyncHandler(async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;

  const { id } = req.params;

  if (!validateObjectId(id)) {
    return errorResponse(res, 400, "Invalid chat ID");
  }

  const chat = await AssistantChat.findOne({
    _id: id,
    userId: getUserId(req),
  }).lean();

  if (!chat) {
    return errorResponse(res, 404, "Chat thread not found");
  }

  return successResponse(res, chat);
});

// DELETE /api/ai-assistant/chats/:id
// Delete individual conversation
const deleteChat = asyncHandler(async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;

  const { id } = req.params;

  if (!validateObjectId(id)) {
    return errorResponse(res, 400, "Invalid chat ID");
  }

  const result = await AssistantChat.deleteOne({
    _id: id,
    userId: getUserId(req),
  });

  if (result.deletedCount === 0) {
    return errorResponse(res, 404, "Chat thread not found");
  }

  return successResponse(
    res,
    null,
    "Chat thread deleted successfully"
  );
});

// Shared handler for content tools
const executeContentTool = (toolFunction, toolName) =>
  asyncHandler(async (req, res) => {
    if (!ensureAuthenticated(req, res)) return;

    const { text, platform } =
      req.validatedBody || req.body;

    const validationError = validateText(text, "Content");

    if (validationError) {
      return errorResponse(res, 400, validationError);
    }

    const result = toolFunction(
      text.trim(),
      platform || DEFAULT_PLATFORM
    );

    if (!result) {
      throw new Error(`${toolName} returned no result`);
    }

    return successResponse(
      res,
      result,
      `${toolName} completed successfully`
    );
  });

// POST /api/ai-assistant/tools/seo
const runSeoTool = executeContentTool(
  analyzeContentSeo,
  "SEO analysis"
);

// POST /api/ai-assistant/tools/predict
const runPredictorTool = executeContentTool(
  predictContentPerformance,
  "Content prediction"
);

// POST /api/ai-assistant/tools/hashtags
const runHashtagTool = executeContentTool(
  generateHashtagMatrix,
  "Hashtag generation"
);

// GET /api/ai-assistant/tools/insights
const runInsightsTool = asyncHandler(async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;

  const insights = generateCreatorInsights({
    niche: req.user?.bio || "Digital Creator",
  });

  return successResponse(
    res,
    insights,
    "Creator insights generated successfully"
  );
});

// POST /api/ai-assistant/export-content-os
// Export assistant recommendations into Content OS
const exportToContentOs = asyncHandler(async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;

  const {
    title,
    description,
    platform,
    type,
  } = req.validatedBody || req.body;

  const titleError = validateText(
    title,
    "Title",
    MAX_TITLE_LENGTH
  );

  if (titleError) {
    return errorResponse(res, 400, titleError);
  }

  if (
    description !== undefined &&
    (typeof description !== "string" || description.length > 10000)
  ) {
    return errorResponse(
      res,
      400,
      "Description must be a string of at most 10000 characters"
    );
  }

  const allowedTypes = [
    "idea",
    "post",
    "video",
    "reel",
    "article",
  ];

  if (type && !allowedTypes.includes(type)) {
    return errorResponse(res, 400, "Invalid content type");
  }

  const newContentItem = await ContentOs.create({
    userId: getUserId(req),
    title: title.trim(),
    description: description || "",
    type: type || "idea",
    status: "idea",
    platform: platform || DEFAULT_PLATFORM,
    priority: "medium",
  });

  return res.status(201).json({
    success: true,
    message: "Successfully exported to Content OS!",
    data: newContentItem,
  });
});

// Export controller functions
module.exports = {
  renderAssistantView,
  sendMessage,
  getChats,
  getChatById,
  deleteChat,
  runSeoTool,
  runPredictorTool,
  runHashtagTool,
  runInsightsTool,
  exportToContentOs,
};
