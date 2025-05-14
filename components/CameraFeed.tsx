'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Camera } from 'lucide-react';
import ConfigPanel from './ConfigPanel';
import ResponsePanel from './ResponsePanel';

// Define types for our component
type AIResponse = {
  text: string;
  timestamp: Date;
};

export default function CameraFeed() {
  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  // State
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [response, setResponse] = useState<string>('Camera ready. Click Start to begin.');
  const [baseURL, setBaseURL] = useState('http://localhost:8080');
  const [instruction, setInstruction] = useState('What do you see?');
  const [interval, setInterval] = useState(500);
  const [systemPrompt, setSystemPrompt] = useState(
    'You are a helpful vision assistant. Describe what you see in the image clearly and concisely.'
  );
  
  // Interval reference for cleanup
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  // Initialize camera on component mount
  useEffect(() => {
    initCamera();
    
    // Cleanup function to stop stream and clear interval
    return () => {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);

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
    
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    
    const context = canvas.getContext('2d');
    if (!context) return null;
    
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
    
    // Then set interval
    intervalRef.current = setInterval(sendData, interval); 
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
    <div className="flex flex-col items-center gap-6 w-full max-w-4xl mx-auto">
      {/* Video feed */}
      <div className="relative">
        <video 
          ref={videoRef}
          className="w-full h-auto max-w-2xl border-2 border-gray-800 rounded-lg bg-black"
          autoPlay 
          playsInline
        />
        <canvas ref={canvasRef} className="hidden" />
        
        {/* Camera status indicator */}
        <div className="absolute top-4 right-4 flex items-center gap-2 bg-black/50 text-white px-3 py-1 rounded-full">
          <Camera size={16} className={stream ? "text-green-500" : "text-red-500"} />
          <span className="text-sm">{stream ? "Camera On" : "No Camera"}</span>
        </div>
      </div>

      {/* Configuration panel */}
      <ConfigPanel
        baseURL={baseURL}
        setBaseURL={setBaseURL}
        instruction={instruction}
        setInstruction={setInstruction}
        interval={interval}
        setInterval={setInterval}
        systemPrompt={systemPrompt}
        setSystemPrompt={setSystemPrompt}
        isProcessing={isProcessing}
        onStart={handleStart}
        onStop={handleStop}
      />

      {/* Response panel */}
      <ResponsePanel response={response} />
    </div>
  );
}