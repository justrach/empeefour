import { Agent } from '@cursor/sdk';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

async function listModels() {
  try {
    console.log('Fetching available models from Cursor SDK...');
    
    // Try to get models information through Agent
    // Let's first check what's available in the SDK
    console.log('Available exports from @cursor/sdk:');
    console.log('- Agent (used in existing code)');
    
    // Let's try to use Agent to explore available models
    const result = await Agent.prompt('List all available models in the Cursor environment, specifically looking for GPT 5.5 models. Return only the model names/IDs.', {
      apiKey: process.env.CURSOR_API_KEY,
      model: { id: "composer-2" },
      local: { cwd: process.cwd() },
    });
    
    console.log('\n=== AGENT RESPONSE ===\n');
    console.log(result.result);
    
    // Also try to ask specifically about GPT 5.5
    const gpt55Result = await Agent.prompt('What is the exact model ID/name for GPT 5.5 in Cursor? I need the precise string to use in the model parameter.', {
      apiKey: process.env.CURSOR_API_KEY,
      model: { id: "composer-2" },
      local: { cwd: process.cwd() },
    });
    
    console.log('\n=== GPT 5.5 SPECIFIC ===\n');
    console.log(gpt55Result.result);
    
  } catch (error) {
    console.error('Error fetching models:', error);
  }
}

listModels();
