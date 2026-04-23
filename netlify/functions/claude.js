export default async (req, context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // FIX 1: Use Deno.env.get() — this is an Edge Function (Deno runtime), process.env is undefined
  const apiKey = Deno.env.get("GROQ_API_KEY");
  if (!apiKey) {
    return new Response(JSON.stringify({ content: [{ text: "" }], error: "GROQ_API_KEY not set" }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return new Response(JSON.stringify({ content: [{ text: "" }], error: "Invalid JSON" }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }

  // FIX 2: Validate messages before sending to Groq
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return new Response(JSON.stringify({ content: [{ text: "" }], error: "Missing or empty messages array" }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }

  const wantStream = body.stream === true;

  // Groq's chat-completions endpoint follows OpenAI format: the system prompt must be
  // the first element of the messages array. A top-level `system` field is silently ignored.
  const SYSTEM_PROMPT = [
    "You are a masterful audio-tour storyteller — part historian, part novelist, part street-level guide.",
    "Your text will be read aloud by text-to-speech software. Write for the ear, not the eye.",
    "",
    "VOICE RULES — non-negotiable:",
    "• Use contractions everywhere: it's, that's, you'll, we've, they'd, didn't, wasn't, couldn't.",
    "• Sentence length: 8–18 words. Vary the rhythm — two short punches, then one longer sweep.",
    "• Use the em-dash for ONE dramatic pause per paragraph — just one, no more.",
    "• No parentheses, no semicolons, no nested clauses. They collapse in speech.",
    "• Spell out numbers when spoken: 'eighteen forty-seven', 'twelve o'clock', 'three hundred years'.",
    "• No abbreviations except well-known ones like St. and Dr.",
    "",
    "STYLE RULES:",
    "• Open in the middle of a scene — a sound, a smell, a gesture, or a named person doing something. Never open with the place's name.",
    "• Use ONE vivid sensory detail: what it looked, sounded, or smelled like in that era.",
    "• Name at least one real person and one real year if the source supports it. Otherwise use a plausible archetype: 'a 19th-century dockworker', 'the sisters who ran it'.",
    "• Include one moment of drama, scandal, tragedy, triumph, mystery, or dark humour — the kind of detail a listener will repeat.",
    "• Speak directly to the listener: 'Look up and you'll see…', 'Stand here long enough and…'.",
    "• End with a lingering image or question that makes the listener look again.",
    "",
    "HARD BANS:",
    "'rich history', 'storied past', 'stood the test of time', 'nestled in', 'steeped in', 'timeless', 'iconic', 'charming', 'picturesque', 'hidden gem', 'bustling', 'must-see'.",
    "No bullet points. No headings. No 'Imagine this:'. No 'Did you know…'. No encyclopedia summaries.",
    "",
    "LENGTH: 200–240 words. Finish cleanly — never cut off mid-sentence. Pure spoken prose only."
  ].join("\n");

  const messagesWithSystem = [
    { role: "system", content: SYSTEM_PROMPT },
    ...body.messages
  ];

  // Retry up to 3 times with backoff on rate limit
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // FIX 3: Add a 20s fetch timeout via AbortController to avoid opaque Netlify platform timeouts
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);

      let response;
      try {
        response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: "llama-3.3-70b-versatile",
            max_tokens: 1500,
            temperature: 0.92,
            top_p: 0.95,
            presence_penalty: 0.4,
            frequency_penalty: 0.3,
            stream: wantStream,
            messages: messagesWithSystem
          })
        });
      } finally {
        clearTimeout(timeout);
      }

      // Rate limited — wait and retry
      if (response.status === 429) {
        const wait = (attempt + 1) * 2000;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      if (!response.ok) {
        const errText = await response.text();
        return new Response(JSON.stringify({ content: [{ text: "" }], error: `Groq ${response.status}: ${errText}` }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      // Streaming: forward Groq's SSE body straight to the client so the browser
      // can start speaking sentences as soon as they arrive.
      if (wantStream) {
        return new Response(response.body, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
            "X-Accel-Buffering": "no"
          }
        });
      }

      const data = await response.json();
      const text = data?.choices?.[0]?.message?.content || "";
      return new Response(JSON.stringify({ content: [{ text }] }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });

    } catch (e) {
      // AbortError = fetch timeout
      const isTimeout = e.name === "AbortError";
      if (attempt === 2) {
        return new Response(JSON.stringify({
          content: [{ text: "" }],
          error: isTimeout ? "Request timed out after 20s" : e.message
        }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  // FIX 4: Explicit fallback return — prevents undefined response if all 3 attempts hit 429
  return new Response(JSON.stringify({ content: [{ text: "" }], error: "Rate limited after 3 attempts" }), {
    status: 429,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
};

export const config = { path: "/api/claude" };
