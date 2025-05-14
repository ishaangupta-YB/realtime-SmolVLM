'use client';

import React from 'react';
import { Settings } from 'lucide-react';

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
    <div className="w-full max-w-2xl bg-white rounded-lg shadow-md p-6">
      <div className="flex flex-col gap-4">
        {/* Basic configuration */}
        <div className="mb-4">
          <div className="mb-4">
            <label htmlFor="instructionText" className="block text-sm font-medium text-gray-700 mb-1">
              Instruction:
            </label>
            <textarea
              id="instructionText"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              disabled={isProcessing}
              className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
              placeholder="What do you want to ask about the camera feed?"
              rows={2}
            />
          </div>

          <div className="flex items-center gap-4">
            <div className="flex-1">
              <label htmlFor="intervalSelect" className="block text-sm font-medium text-gray-700 mb-1">
                Interval between requests:
              </label>
              <select
                id="intervalSelect"
                value={interval}
                onChange={(e) => setInterval(Number(e.target.value))}
                disabled={isProcessing}
                className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
              >
                <option value={100}>100ms</option>
                <option value={250}>250ms</option>
                <option value={500}>500ms</option>
                <option value={1000}>1s</option>
                <option value={2000}>2s</option>
              </select>
            </div>
            
            <div className="flex-none">
              <button
                onClick={isProcessing ? onStop : onStart}
                className={`mt-6 px-6 py-2 rounded-md font-medium text-white ${
                  isProcessing 
                    ? 'bg-red-600 hover:bg-red-700' 
                    : 'bg-green-600 hover:bg-green-700'
                }`}
              >
                {isProcessing ? 'Stop' : 'Start'}
              </button>
            </div>
          </div>
        </div>
        
        {/* Advanced settings toggle */}
        <div>
          <button 
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-2 text-sm text-gray-700 hover:text-gray-900"
          >
            <Settings size={16} />
            <span>{showAdvanced ? 'Hide Advanced Settings' : 'Show Advanced Settings'}</span>
          </button>
        </div>

        {/* Advanced settings */}
        {showAdvanced && (
          <div className="mt-2 border-t pt-4">
            <div className="mb-4">
              <label htmlFor="baseURL" className="block text-sm font-medium text-gray-700 mb-1">
                API Base URL:
              </label>
              <input
                id="baseURL"
                type="text"
                value={baseURL}
                onChange={(e) => setBaseURL(e.target.value)}
                disabled={isProcessing}
                className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
              />
            </div>
            
            <div>
              <label htmlFor="systemPrompt" className="block text-sm font-medium text-gray-700 mb-1">
                System Prompt:
              </label>
              <textarea
                id="systemPrompt"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                disabled={isProcessing}
                className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
                rows={4}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}