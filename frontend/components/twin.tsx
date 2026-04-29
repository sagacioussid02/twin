'use client';

import { useState, useRef, useEffect } from 'react';
import { useAuth } from '@clerk/nextjs';
import Link from 'next/link';
import { Send, User } from 'lucide-react';

interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date | null;
    grounding?: {
        answer_type: string;
        confidence_label: string;
        grounding_mode: string;
    };
    sources?: Array<{
        source_id: string;
        title: string;
        snippet: string;
        confidence: string;
    }>;
}

const AVATAR_URL = 'https://i.pravatar.cc/150?img=12&u=sidd';
const WELCOME_MESSAGE_ID = 'welcome-message';
const WELCOME_TEXT = "Hi, I'm Sidd's twin — ask me anything.";
const FEEDBACK_HINT = 'I want to give feedback';
const CONTACT_HINT = 'Contact Sidd';

export default function Twin() {
    const { isSignedIn, getToken } = useAuth();
    const [messages, setMessages] = useState<Message[]>(() => [{
        id: WELCOME_MESSAGE_ID,
        role: 'assistant',
        content: WELCOME_TEXT,
        timestamp: null, // null avoids SSR/client hydration mismatch
    }]);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [sessionId, setSessionId] = useState<string>('');
    const MAX_ANON_EXCHANGES = 5;
    const userMessageCount = messages.filter(m => m.role === 'user').length;
    const limitReached = !isSignedIn && userMessageCount >= MAX_ANON_EXCHANGES;
    const showHints = input.trim().length === 0
        && userMessageCount === 0
        && messages.length === 1
        && messages[0].id === WELCOME_MESSAGE_ID;
    const messagesEndRef = useRef<HTMLDivElement>(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages]);

    const sendMessage = async (messageOverride?: string) => {
        const messageText = (messageOverride ?? input).trim();
        if (!messageText || isLoading) return;

        const userMessage: Message = {
            id: Date.now().toString(),
            role: 'user',
            content: messageText,
            timestamp: new Date(),
        };

        setMessages(prev => [...prev, userMessage]);
        setInput('');
        setIsLoading(true);

        try {
            const token = isSignedIn ? await getToken() : null;
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            if (token) headers['Authorization'] = `Bearer ${token}`;

            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'}/chat`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    message: messageText,
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
                grounding: data.grounding,
                sources: data.sources ?? [],
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
                            {message.role === 'assistant' && ((message.sources && message.sources.length > 0) || message.grounding) && (
                                <div className="mt-2 space-y-2">
                                    {message.grounding && (
                                        <div className="flex flex-wrap gap-1.5">
                                            <span className="text-[11px] px-2 py-1 rounded-full border bg-gray-50 text-gray-600 border-gray-200">
                                                {message.grounding.confidence_label} confidence
                                            </span>
                                            <span className="text-[11px] px-2 py-1 rounded-full border bg-blue-50 text-blue-700 border-blue-200">
                                                {message.grounding.grounding_mode}
                                            </span>
                                        </div>
                                    )}
                                    {message.sources && message.sources.length > 0 && (
                                        <div className="space-y-1.5">
                                            {message.sources.slice(0, 2).map(source => (
                                                <div key={source.source_id} className="rounded-md border border-gray-200 bg-gray-50 px-2.5 py-2">
                                                    <p className="text-[11px] font-medium text-gray-700">Based on {source.title}</p>
                                                    <p className="text-xs text-gray-500 mt-1">{source.snippet}</p>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}
                            <p
                                className={`text-xs mt-1 ${
                                    message.role === 'user' ? 'text-slate-300' : 'text-gray-500'
                                }`}
                            >
                                {message.timestamp?.toLocaleTimeString()}
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

                {showHints && (
                    <div className="flex flex-wrap gap-2 pl-11">
                        <button
                            type="button"
                            onClick={() => sendMessage(FEEDBACK_HINT)}
                            className="text-xs text-gray-400 hover:text-gray-700 border border-gray-200 hover:border-gray-300 bg-white rounded-full px-3 py-1 transition-colors"
                        >
                            {FEEDBACK_HINT}
                        </button>
                        <button
                            type="button"
                            onClick={() => sendMessage(CONTACT_HINT)}
                            className="text-xs text-gray-400 hover:text-gray-700 border border-gray-200 hover:border-gray-300 bg-white rounded-full px-3 py-1 transition-colors"
                        >
                            {CONTACT_HINT}
                        </button>
                    </div>
                )}

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
                        <Link href="/sign-up" className="px-4 py-1.5 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-700 transition-colors">
                            Sign up free
                        </Link>
                        <Link href="/sign-in" className="px-4 py-1.5 border border-gray-300 text-gray-600 text-sm rounded-lg hover:bg-gray-50 transition-colors">
                            Sign in
                        </Link>
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
                            onClick={() => sendMessage()}
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
