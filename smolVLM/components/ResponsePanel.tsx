'use client';

import React from 'react';
import { Brain } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { motion } from "framer-motion";

type ResponsePanelProps = {
  response: string;
};

const MotionCard = motion(Card);

export default function ResponsePanel({ response }: ResponsePanelProps) {
  // Create a reference to track when the response changes for animation
  const [prevResponse, setPrevResponse] = React.useState(response);
  const [isNewResponse, setIsNewResponse] = React.useState(false);
  
  React.useEffect(() => {
    if (response !== prevResponse) {
      setPrevResponse(response);
      setIsNewResponse(true);
      // Reset the animation flag after a short delay
      const timer = setTimeout(() => setIsNewResponse(false), 500);
      return () => clearTimeout(timer);
    }
  }, [response, prevResponse]);

  return (
    <MotionCard 
      className="h-auto bg-background/80 backdrop-blur-sm shadow-lg"
      whileHover={{ boxShadow: "0 10px 20px rgba(0,0,0,0.1)" }}
    >
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <Brain className="h-5 w-5 text-primary" />
          AI Response
        </CardTitle>
        <CardDescription>Live analysis from vision model</CardDescription>
      </CardHeader>
      
      <CardContent>
        <motion.div
          className="bg-muted/20 border border-border rounded-md p-4 h-[30vh] lg:h-[35vh] overflow-y-auto custom-scrollbar whitespace-pre-wrap text-foreground"
          animate={isNewResponse ? 
            { backgroundColor: ['rgba(var(--primary)/0.15)', 'rgba(var(--primary)/0.05)'] } 
            : {}}
          transition={{ duration: 0.5 }}
        >
          <motion.div
            key={response} // Key helps React identify which items have changed
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
          >
            {response}
          </motion.div>
        </motion.div>
      </CardContent>
    </MotionCard>
  );
}