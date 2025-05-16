'use client';

import React from 'react';
import { Settings, Send, StopCircle } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { motion } from "framer-motion";

type ConfigPanelProps = {
  baseURL: string;
  setBaseURL: (url: string) => void;
  instruction: string;
  setInstruction: (instruction: string) => void;
  interval: number;
  setInterval: (interval: number) => void;
  systemPrompt: string;
  setSystemPrompt: (prompt: string) => void;
  isProcessing: boolean;
  onStart: () => void;
  onStop: () => void;
};

const MotionCard = motion(Card);

export default function ConfigPanel({
  baseURL,
  setBaseURL,
  instruction,
  setInstruction,
  interval,
  setInterval,
  systemPrompt,
  setSystemPrompt,
  isProcessing,
  onStart,
  onStop
}: ConfigPanelProps) {
  const [showAdvanced, setShowAdvanced] = React.useState(false);

  return (
    <MotionCard 
      className="h-auto bg-background/80 backdrop-blur-sm shadow-lg"
      whileHover={{ boxShadow: "0 10px 20px rgba(0,0,0,0.1)" }}
    >
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <Settings className="h-5 w-5 text-primary" />
          Configuration
        </CardTitle>
        <CardDescription>Set up your vision AI parameters</CardDescription>
      </CardHeader>
      
      <CardContent className="space-y-4 overflow-y-auto custom-scrollbar max-h-[30vh] lg:max-h-[40vh]">
        {/* Basic configuration */}
        <motion.div 
          className="space-y-2"
          initial={{ opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
        >
          <label htmlFor="instructionText" className="text-sm font-medium">
            Instruction:
          </label>
          <Textarea
            id="instructionText"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            disabled={isProcessing}
            placeholder="What do you want to ask about the camera feed?"
            className="resize-none"
            rows={2}
          />
        </motion.div>

        <motion.div 
          className="space-y-2"
          initial={{ opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.1 }}
        >
          <label htmlFor="intervalSelect" className="text-sm font-medium">
            Refresh Interval:
          </label>
          <select
            id="intervalSelect"
            value={interval}
            onChange={(e) => setInterval(Number(e.target.value))}
            disabled={isProcessing}
            className="w-full h-10 px-3 py-2 bg-background text-foreground border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
          >
            <option value={100}>100ms (Fastest)</option>
            <option value={250}>250ms (Fast)</option>
            <option value={500}>500ms (Normal)</option>
            <option value={1000}>1s (Slow)</option>
            <option value={2000}>2s (Slowest)</option>
          </select>
        </motion.div>
        
        {/* Advanced settings toggle */}
        <motion.div
          initial={{ opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.2 }}
        >
          <Button 
            variant="ghost"
            size="sm"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="w-full justify-start text-muted-foreground font-normal"
          >
            <Settings size={16} className="mr-2 text-primary" />
            <span>{showAdvanced ? 'Hide Advanced Settings' : 'Show Advanced Settings'}</span>
          </Button>
        </motion.div>

        {/* Advanced settings */}
        {showAdvanced && (
          <motion.div 
            className="space-y-4 pt-2 border-t"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.3 }}
          >
            <div className="space-y-2">
              <label htmlFor="baseURL" className="text-sm font-medium">
                API Base URL:
              </label>
              <Input
                id="baseURL"
                type="text"
                value={baseURL}
                onChange={(e) => setBaseURL(e.target.value)}
                disabled={isProcessing}
              />
            </div>
            
            <div className="space-y-2">
              <label htmlFor="systemPrompt" className="text-sm font-medium">
                System Prompt:
              </label>
              <Textarea
                id="systemPrompt"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                disabled={isProcessing}
                className="resize-none"
                rows={3}
              />
            </div>
          </motion.div>
        )}
      </CardContent>
      
      {/* Control buttons */}
      <CardFooter className="pt-2">
        <motion.div 
          className="w-full"
          whileTap={{ scale: 0.98 }}
        >
          <Button
            onClick={isProcessing ? onStop : onStart}
            variant={isProcessing ? "destructive" : "default"}
            className="w-full gap-2"
            size="lg"
          >
            {isProcessing 
              ? <><StopCircle size={18} /> Stop Processing</>
              : <><Send size={18} /> Start Processing</>
            }
          </Button>
        </motion.div>
      </CardFooter>
    </MotionCard>
  );
}