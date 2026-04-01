'use client';

import { useState, useRef, useEffect } from 'react';
import { Send, User } from 'lucide-react';
import Image from 'next/image';

interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
}

interface TwinProps {
    isSignedIn?: boolean;
}

const AVATAR_URL = 'https://i.pravatar.cc/150?img=12&u=sidd';

export default function Twin({ isSignedIn = false }: TwinProps) {
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [sessionId, setSessionId] = useState<string>('');
    const MAX_ANON_EXCHANGES = 5;
    const userMessageCount = messages.filter(m => m.role === 'user').length;
    const limitReached = !isSignedIn && userMessageCount >= MAX_ANON_EXCHANGES;
    const messagesEndRef = useRef<HTMLDivElement>(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages]);

    const sendMessage = async () => {
        if (!input.trim() || isLoading) return;

        const userMessage: Message = {
            id: Date.now().toString(),
            role: 'user',
            content: input,
            timestamp: new Date(),
        };

        setMessages(prev => [...prev, userMessage]);
        setInput('');
        setIsLoading(true);

        try {
            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'}/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    message: input,
                    session_id: sessionId || undefined,
                }),
            });

            if (!response.ok) throw new Error('Failed to send message');

            const data = await response.json();

            if (!sessionId) {
                setSessionId(data.session_id);
            }

            const assistantMessage: Message = {
                id: (Date.now() + 1).toString(),
                role: 'assistant',
                content: data.response,
                timestamp: new Date(),
            };

            setMessages(prev => [...prev, assistantMessage]);
        } catch (error) {
            console.error('Error:', error);
            // Add error message
            const errorMessage: Message = {
                id: (Date.now() + 1).toString(),
                role: 'assistant',
                content: 'Sorry, I encountered an error. Please try again.',
                timestamp: new Date(),
            };
            setMessages(prev => [...prev, errorMessage]);
        } finally {
            setIsLoading(false);
        }
    };

    const handleKeyPress = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    return (
        <div className="flex flex-col h-full bg-gray-50 rounded-lg shadow-lg">
            {/* Header */}
            <div className="bg-gradient-to-r from-purple-600 to-blue-600 text-white p-4 rounded-t-lg">
                <h2 className="text-xl font-semibold flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full overflow-hidden bg-white">
                        <img src={AVATAR_URL} alt="Sidd's Twin" className="w-full h-full object-cover" />
                    </div>
                    Talk to Sidd&apos;s Twin
                </h2>
                <p className="text-sm text-purple-100 mt-1">✨ Intelligent conversations powered by AI ✨</p>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {messages.length === 0 && (
                    <div className="text-center text-gray-500 mt-8">
                        <div className="w-12 h-12 mx-auto mb-3 rounded-full overflow-hidden bg-gray-200">
                            <img src={AVATAR_URL} alt="Sidd's Twin" className="w-full h-full object-cover" />
                        </div>
                        <p className="font-semibold text-gray-700">👨‍💼 Meet Sidd&apos;s AI Twin</p>
                        <p className="text-sm mt-2 text-gray-600">Your professional AI companion for tech, AI & innovation</p>
                    </div>
                )}

                {messages.map((message) => (
                    <div
                        key={message.id}
                        className={`flex gap-3 ${
                            message.role === 'user' ? 'justify-end' : 'justify-start'
                        }`}
                    >
                        {message.role === 'assistant' && (
                            <div className="flex-shrink-0">
                                <div className="w-8 h-8 rounded-full overflow-hidden bg-white border border-gray-200 flex items-center justify-center">
                                    <img src={AVATAR_URL} alt="Sidd's Twin" className="w-full h-full object-cover" />
                                </div>
                            </div>
                        )}

                        <div
                            className={`max-w-[70%] rounded-lg p-3 ${
                                message.role === 'user'
                                    ? 'bg-slate-700 text-white'
                                    : 'bg-white border border-gray-200 text-gray-800'
                            }`}
                        >
                            <p className="whitespace-pre-wrap">{message.content}</p>
                            <p
                                className={`text-xs mt-1 ${
                                    message.role === 'user' ? 'text-slate-300' : 'text-gray-500'
                                }`}
                            >
                                {message.timestamp.toLocaleTimeString()}
                            </p>
                        </div>

                        {message.role === 'user' && (
                            <div className="flex-shrink-0">
                                <div className="w-8 h-8 bg-gray-600 rounded-full flex items-center justify-center">
                                    <User className="w-5 h-5 text-white" />
                                </div>
                            </div>
                        )}
                    </div>
                ))}

                {isLoading && (
                    <div className="flex gap-3 justify-start">
                        <div className="flex-shrink-0">
                            <div className="w-8 h-8 rounded-full overflow-hidden bg-white border border-gray-200 flex items-center justify-center">
                                <img src={AVATAR_URL} alt="Sidd's Twin" className="w-full h-full object-cover" />
                            </div>
                        </div>
                        <div className="bg-white border border-gray-200 rounded-lg p-3">
                            <div className="flex space-x-2">
                                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" />
                                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce delay-100" />
                                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce delay-200" />
                            </div>
                        </div>
                    </div>
                )}

                <div ref={messagesEndRef} />
            </div>

            {/* Input / sign-in wall */}
            {limitReached ? (
                <div className="border-t border-gray-200 p-5 bg-purple-50 rounded-b-lg text-center">
                    <p className="text-sm font-semibold text-purple-800 mb-1">Want to keep chatting?</p>
                    <p className="text-xs text-gray-500 mb-3">Sign up free to continue — no credit card needed.</p>
                    <div className="flex gap-2 justify-center">
                        <a href="/sign-up" className="px-4 py-1.5 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-700 transition-colors">
                            Sign up free
                        </a>
                        <a href="/sign-in" className="px-4 py-1.5 border border-gray-300 text-gray-600 text-sm rounded-lg hover:bg-gray-50 transition-colors">
                            Sign in
                        </a>
                    </div>
                </div>
            ) : (
                <div className="border-t border-gray-200 p-4 bg-white rounded-b-lg">
                    <div className="flex gap-2">
                        <div className="flex-1 relative">
                            <input
                                type="text"
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                onKeyDown={handleKeyPress}
                                placeholder="Type your message…"
                                maxLength={100}
                                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-600 focus:border-transparent text-gray-800"
                                disabled={isLoading}
                            />
                            {input.length > 80 && (
                                <span className="absolute right-3 bottom-2 text-xs text-gray-400">{input.length}/100</span>
                            )}
                        </div>
                        <button
                            onClick={sendMessage}
                            disabled={!input.trim() || isLoading}
                            className="px-4 py-2 bg-slate-700 text-white rounded-lg hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            aria-label="Send message"
                        >
                            <Send className="w-5 h-5" />
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}