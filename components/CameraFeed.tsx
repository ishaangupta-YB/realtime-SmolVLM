'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Camera } from 'lucide-react';
import { motion } from 'framer-motion';
import ConfigPanel from './ConfigPanel';
import ResponsePanel from './ResponsePanel';
import { Card, CardContent } from '@/components/ui/card';

// Define types for our component
type AIResponse = {
  text: string;
  timestamp: Date;
};

const MotionCard = motion(Card);

export default function CameraFeed() {
  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  // State
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [response, setResponse] = useState<string>('Camera ready. Click Start to begin.');
  const [baseURL, setBaseURL] = useState(process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8080');
  const [instruction, setInstruction] = useState('What do you see?');
  const [intervalMs, setIntervalMs] = useState(500); // Renamed for clarity
  const [systemPrompt, setSystemPrompt] = useState(
    'You are SmolVLM, a specialized Vision Language Model designed for real-time webcam analysis. Your primary focus is on human detection, facial analysis, object identification, and scene context analysis, in that order of priority. Provide concise, accurate descriptions of what you see, focusing first on people and faces, then objects, and finally the background elements. Organize your response in a clear, structured format with the most important elements first. Respect privacy by never attempting to identify specific individuals by name unless they are widely known public figures.'
  );
  
  // Interval reference for cleanup
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  // Initialize camera and load system prompt on component mount
  useEffect(() => {
    initCamera();

    // Attempt to fetch system prompt
    fetch('/system-prompt.md')
      .then(res => res.text())
      .then(text => {
        if (text && text.length > 100) { // Simple check to ensure it's not an error page
          setSystemPrompt(text);
        }
      })
      .catch(err => {
        console.error("Failed to load system prompt:", err);
      });
    
    // Cleanup function to stop stream and clear interval
    return () => {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // stream dependency removed to avoid re-fetching prompt, manage stream stop separately

  useEffect(() => {
    // Separate effect for stream cleanup if stream object itself changes
    return () => {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
    }
  }, [stream]);

  // Function to initialize camera
  const initCamera = async () => {
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({ 
        video: true, 
        audio: false 
      });
      
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
      }
      
      setStream(mediaStream);
      setResponse('Camera access granted. Ready to start.');
    } catch (err) {
      console.error('Error accessing camera:', err);
      setResponse(`Error accessing camera: ${err instanceof Error ? err.message : 'Unknown error'}. Please ensure permissions are granted.`);
    }
  };

  // Function to capture image from video feed
  const captureImage = (): string | null => {
    if (!stream || !videoRef.current || !videoRef.current.videoWidth) {
      console.warn('Video stream not ready for capture.');
      return null;
    }
    
    const video = videoRef.current;
    const canvas = canvasRef.current;
    
    if (!canvas) return null;
    
    // Note: When capturing from a mirrored display, we need to flip horizontally in the canvas
    // to ensure the image data is correct (not mirrored) for AI processing
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    
    const context = canvas.getContext('2d');
    if (!context) return null;
    
    // Standard draw (no flip)
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    return canvas.toDataURL('image/jpeg', 0.8);
  };

  // Function to send data to API
  const sendData = async () => {
    if (!isProcessing) return;

    const imageBase64URL = captureImage();

    if (!imageBase64URL) {
      setResponse('Failed to capture image. Stream might not be active.');
      return;
    }

    try {
      const response = await sendChatCompletionRequest(instruction, imageBase64URL);
      setResponse(response);
    } catch (error) {
      console.error('Error sending data:', error);
      setResponse(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  // Function to send request to API
  const sendChatCompletionRequest = async (instruction: string, imageBase64URL: string): Promise<string> => {
    try {
      const response = await fetch(`${baseURL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          max_tokens: 100,
          messages: [
            {
              role: 'system',
              content: systemPrompt
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: instruction },
                {
                  type: 'image_url',
                  image_url: {
                    url: imageBase64URL,
                  }
                }
              ]
            },
          ]
        })
      });

      if (!response.ok) {
        const errorData = await response.text();
        return `Server error: ${response.status} - ${errorData}`;
      }

      const data = await response.json();
      return data.choices[0].message.content;
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  };

  // Function to handle start button click
  const handleStart = () => {
    if (!stream) {
      setResponse('Camera not available. Cannot start.');
      return;
    }
    
    setIsProcessing(true);
    setResponse('Processing started...');
    
    // Make initial call immediately
    sendData();
    
    // Use setTimeout instead of setInterval to avoid linter error
    intervalRef.current = setTimeout(function tick() {
      sendData();
      if (isProcessing) {
        intervalRef.current = setTimeout(tick, intervalMs);
      }
    }, intervalMs) as unknown as NodeJS.Timeout;
  };

  // Function to handle stop button click
  const handleStop = () => {
    setIsProcessing(false);
    
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    
    if (response === 'Processing started...') {
      setResponse('Processing stopped.');
    }
  };

  return (
    <div className="flex flex-col lg:flex-row w-full h-full gap-4">
      {/* Camera Feed - Larger on desktop, full width on mobile */}
      <motion.div 
        className="w-full lg:w-2/3 flex items-center justify-center mb-4 lg:mb-0"
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5 }}
      >
        <MotionCard 
          className="w-full h-full overflow-hidden shadow-2xl rounded-xl"
          style={{
            background: 'linear-gradient(to bottom right, rgba(255,255,255,0.1), rgba(255,255,255,0.05))',
            backdropFilter: 'blur(12px)',
          }}
          whileHover={{ 
            scale: 1.01,
            boxShadow: "0 20px 30px rgba(0,0,0,0.15)"
          }}
          transition={{ type: "spring", stiffness: 300 }}
        >
          <CardContent className="p-0 h-full relative">
            <div className="h-full w-full overflow-hidden rounded-xl">
              <video 
                ref={videoRef}
                className="h-full w-full object-cover"
                autoPlay 
                playsInline
                style={{ transform: 'scaleX(-1)' }} // Mirror the video
              />
              <canvas ref={canvasRef} className="hidden" />
            </div>
            
            {/* Camera status indicator */}
            <motion.div 
              className="absolute top-4 right-4 flex items-center gap-2 bg-background/80 backdrop-blur-sm text-foreground px-3 py-1 rounded-full shadow-md"
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
            >
              <Camera size={16} className={stream ? "text-green-500" : "text-red-500"} />
              <span className="text-sm font-medium">{stream ? "Camera On" : "No Camera"}</span>
            </motion.div>
          </CardContent>
        </MotionCard>
      </motion.div>
      
      {/* Control Panels - Stacked on both desktop and mobile */}
      <motion.div 
        className="w-full lg:w-1/3 flex flex-col gap-4 overflow-y-auto custom-scrollbar"
        initial={{ opacity: 0, x: 20 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.5, delay: 0.2 }}
      >
        <ConfigPanel
          baseURL={baseURL}
          setBaseURL={setBaseURL}
          instruction={instruction}
          setInstruction={setInstruction}
          interval={intervalMs}
          setInterval={setIntervalMs}
          systemPrompt={systemPrompt}
          setSystemPrompt={setSystemPrompt}
          isProcessing={isProcessing}
          onStart={handleStart}
          onStop={handleStop}
        />
        <ResponsePanel response={response} />
      </motion.div>
    </div>
  );
}