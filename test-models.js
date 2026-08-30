import { GoogleGenAI } from '@google/genai';
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function testModel(modelName) {
  try {
    const res = await ai.models.generateContent({
      model: modelName,
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    });
    console.log(`Model ${modelName}: SUCCESS`);
  } catch (err) {
    console.log(`Model ${modelName}: FAILED - ${err.message}`);
  }
}

async function run() {
  await testModel('gemini-flash-latest');
  await testModel('gemini-3.1-flash-lite');
  await testModel('gemini-3.5-flash-lite');
  await testModel('gemini-3.7-flash');
}
run();
