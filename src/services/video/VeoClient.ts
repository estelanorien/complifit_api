import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";
import path from "path";

// Define the Video Generation Interface
export interface VideoGenerationParams {
  prompt: string;
  imagePath?: string; // Optional reference image (for consistency)
  outputPath: string;
}

export class VeoClient {
  private genAI: GoogleGenerativeAI;
  private model: any;

  constructor() {
    // Initialize Gemini API
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not set in environment variables.");
    }
    this.genAI = new GoogleGenerativeAI(apiKey);
    
    // Veo 3.1 (Gemini API): veo-3.1-generate-preview or veo-3.1-fast-generate-preview
    this.model = this.genAI.getGenerativeModel({ model: "veo-3.1-generate-preview" });
  }

  /**
   * Generates a video from a prompt and optional reference image.
   * Veo 3.1 supports Image-to-Video.
   */
  async generateVideo(params: VideoGenerationParams): Promise<void> {

    try {
      // 1. Prepare Content
      // For Veo, we might need to use the specific `generateVideos` method if available in the SDK
      // or standard `generateContent` with specific configurations.
      // NOTE: The Node.js SDK for Veo might be bleeding edge. 
      // If `generateVideos` isn't in the typed SDK yet, we might need a REST fallback.
      // For now, assuming standard generative structure or patching.
      
      // Attempting to use the model standard interaction.
      // If the SDK doesn't natively support video generation types yet, this might fail 
      // and we'll switch to REST. 
      
      // Check for reference image
      let imagePart = null;
      if (params.imagePath && fs.existsSync(params.imagePath)) {
          const imageBuffer = fs.readFileSync(params.imagePath);
          imagePart = {
              inlineData: {
                  data: imageBuffer.toString("base64"),
                  mimeType: "image/png" // Assuming PNG for now
              }
          };
      }

      // 2. Call API
      // Since specific Veo typing might be missing in common @google/generative-ai versions,
      // We will look for the specific method or valid prompt structure.
      // "generateContent" is the standard entry.
      // However, Veo usually requires a specific `generateVideos` operation via REST.
      // If the current SDK version doesn't export it, we should use `fetch` to the REST endpoint.
      
      // SWITCHING TO REST IMPLEMENTATION TO BE SAFE
      // The SDK wrapper often lags behind the Veo 3.1 preview endpoints.
      await this.generateVideoRest(params);

    } catch (error) {
      throw error;
    }
  }

  /**
   * REST Implementation for Veo 3.1
   */
  private async generateVideoRest(params: VideoGenerationParams): Promise<void> {
      const apiKey = process.env.GEMINI_API_KEY;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-generate-preview:predictVideo?key=${apiKey}`;
      
      // Payload construction
      const requestBody: any = {
          prompt: { text: params.prompt }
      };

      if (params.imagePath) {
          const imageBase64 = fs.readFileSync(params.imagePath).toString("base64");
          // Veo Image-to-Video spec
          requestBody.image = {
              image_bytes: imageBase64
          };
      }

      const response = await fetch(url, {
          method: "POST",
          headers: {
              "Content-Type": "application/json"
          },
          body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Veo API Error: ${response.status} ${response.statusText} - ${errText}`);
      }

      const data = await response.json();
      
      // Veo returns a long-running operation or direct content?
      // Usually it's an Operation. We need to poll.
      if (data.name) {
          await this.pollOperation(data.name, params.outputPath, apiKey!);
      }
  }

  private async pollOperation(operationName: string, outputPath: string, apiKey: string): Promise<void> {
      const pollUrl = `https://generativelanguage.googleapis.com/v1beta/${operationName}?key=${apiKey}`;
      
      let attempts = 0;
      const maxAttempts = 60; // 10 minutes (10s interval)
      
      while (attempts < maxAttempts) {
          await new Promise(r => setTimeout(r, 10000)); // Wait 10s
          
          const res = await fetch(pollUrl);
          const data = await res.json();
          
          if (data.done) {
              if (data.error) {
                  throw new Error(`Video generation failed: ${data.error.message}`);
              }
              
              // Video is ready. Download it.
              // data.response.generatedVideos[0].video.uri usually
              const videoUri = data.response?.generatedVideos?.[0]?.video?.uri;
              if (videoUri) {
                  await this.downloadVideo(videoUri, outputPath);
                  return;
              } else {
                 throw new Error("No video URI found in completed operation.");
              }
          }
          
          attempts++;
      }
      
      throw new Error("Video generation timed out.");
  }

  private async downloadVideo(uri: string, localPath: string): Promise<void> {
       const res = await fetch(uri);
       const buffer = await res.arrayBuffer();
       fs.writeFileSync(localPath, Buffer.from(buffer));
  }
}
