'use client';

import React from 'react';

type ResponsePanelProps = {
  response: string;
};

export default function ResponsePanel({ response }: ResponsePanelProps) {
  return (
    <div className="w-full max-w-2xl bg-white rounded-lg shadow-md p-6">
      <h2 className="text-lg font-semibold mb-2">AI Response</h2>
      
      <div className="bg-gray-50 border border-gray-200 rounded-md p-4 h-32 overflow-y-auto whitespace-pre-wrap">
        {response}
      </div>
    </div>
  );
}