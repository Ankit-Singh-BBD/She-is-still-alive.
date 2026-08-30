import { GoogleGenAI } from '@google/genai';
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
async function run() {
  try {
    for (let i = 0; i < 25; i++) {
        await ai.models.generateContent({
          model: 'gemini-3.5-flash-lite',
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        });
    }
    console.log(`Model gemini-3.5-flash-lite: SUCCESS on 25 calls`);
  } catch (err) {
    console.log(`Model gemini-3.5-flash-lite: FAILED - ${err.message}`);
  }
}
run();
