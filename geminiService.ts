
import { GoogleGenAI, Type } from "@google/genai";

export interface SearchExpansion {
  synonyms: string[];
  categories: string[];
  explanation: string;
}

export const getSmartExpansion = async (query: string): Promise<SearchExpansion | null> => {
  if (!query || query.length < 3) return null;

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `Atue como um especialista em taxonomia de compras públicas brasileiras (SIASG/CATMAT/CATSER).
      O usuário buscou por: "${query}".
      
      Sua tarefa é expandir essa busca para encontrar itens no catálogo que usam linguagem formal.
      REGRAS:
      1. Decomponha termos compostos. Se for "conserto de algo", inclua "manutenção", "reparo", "assistência técnica".
      2. Use termos técnicos equivalentes (ex: "ar-condicionado" -> "climatização", "refrigeração", "split").
      3. Inclua variações de classe (ex: "serviços de engenharia", "manutenção de máquinas").
      4. Foque em termos que costumam aparecer em nomes de itens do SIASG.
      
      Retorne APENAS um JSON seguindo este esquema:
      {
        "synonyms": string[], // termos relacionados, verbos de ação e substantivos técnicos
        "categories": string[], // grupos ou classes prováveis no SIASG
        "explanation": string // explicação curtíssima do que a IA entendeu
      }`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            synonyms: { type: Type.ARRAY, items: { type: Type.STRING } },
            categories: { type: Type.ARRAY, items: { type: Type.STRING } },
            explanation: { type: Type.STRING }
          },
          required: ["synonyms", "categories", "explanation"]
        }
      }
    });

    const text = response.text;
    if (!text) return null;
    return JSON.parse(text) as SearchExpansion;
  } catch (error) {
    console.error("Erro na expansão semântica:", error);
    return null;
  }
};
