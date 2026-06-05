import React, { useState, useEffect, useRef } from "react";
import { DifyAgent } from "./DifyAgent";
import type { Message } from "@ag-ui/client";
import { v4 as uuidv4 } from "uuid";
import { loginUser } from "./auth/auth";

// Read environment variables (pointing to secure proxy)
const apiUrl = import.meta.env.VITE_DIFY_API_URL;

interface ChatSession {
  id: string;
  title: string;
  icon: string;
  conversationId: string | null;
  messages: Message[];
  createdAt: number;
}

export default function App() {
  // UI flow state: login -> signup -> packages -> payment -> chat
  const [screen, setScreen] = useState<'login' | 'signup' | 'packages' | 'payment' | 'chat'>('login');

  // Auth form state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [user, setUser] = useState<any | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isRestoring, setIsRestoring] = useState(true);
  const [prevScreen, setPrevScreen] = useState<typeof screen | null>(null);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  // Package / payment state
  const [selectedPackage, setSelectedPackage] = useState<number | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<string>('bank');
  const [packageError, setPackageError] = useState('');
  const [agent] = useState(() => new DifyAgent({
    apiUrl,
    threadId: `thread_${uuidv4()}`,
    debug: true
  }));

  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Dynamic sessions state backed by localStorage
  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    const saved = localStorage.getItem("arg_chat_sessions");
    return saved ? JSON.parse(saved) : [];
  });
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  // A synchronous ref tracking the active session ID to prevent race conditions and stale closure states during streams
  const activeSessionIdRef = useRef<string | null>(null);

  const changeActiveSessionId = (id: string | null) => {
    setActiveSessionId(id);
    activeSessionIdRef.current = id;
  };

  const navigateTo = (newScreen: typeof screen) => {
    setPrevScreen(screen);
    setScreen(newScreen);
  };

  const showNavbar = screen !== 'login' && screen !== 'signup';
  const showBack = screen !== 'login' && screen !== 'chat';
  const getDisplayName = () => {
    if (!user) return '';
    return user.name || user.fullName || user.email || '';
  };

  const handleLogout = () => {
    sessionStorage.removeItem('accessToken');
    sessionStorage.removeItem('user');
    sessionStorage.removeItem('appScreen');
    localStorage.removeItem('accessToken');
    localStorage.removeItem('user');
    localStorage.removeItem('appScreen');
    setUser(null);
    setIsAuthenticated(false);
    setShowProfileMenu(false);
    navigateTo('login');
  };

  const handleBack = () => {
    if (prevScreen) {
      setScreen(prevScreen);
      setPrevScreen(null);
    } else {
      navigateTo('login');
    }
  };

  useEffect(() => {
    // Restore session from sessionStorage if available
    const token = sessionStorage.getItem('accessToken') || localStorage.getItem('accessToken');
    const userJson = sessionStorage.getItem('user') || localStorage.getItem('user');
    const savedScreen = sessionStorage.getItem('appScreen') || localStorage.getItem('appScreen');
    if (token && userJson) {
      try {
        const parsed = JSON.parse(userJson);
        setUser(parsed);
        setIsAuthenticated(true);

        if (savedScreen && ['packages', 'payment', 'chat'].includes(savedScreen)) {
          setScreen(savedScreen as typeof screen);
        } else {
          if (!parsed?.Haslawportalsubfee) {
            setScreen('packages');
          } else {
            setScreen('chat');
          }
        }
      } catch {
        // ignore parse errors and stay on login
      }
    }
    setIsRestoring(false);
  }, []);

  useEffect(() => {
    if (screen !== 'login' && screen !== 'signup') {
      sessionStorage.setItem('appScreen', screen);
      localStorage.setItem('appScreen', screen);
    } else {
      sessionStorage.removeItem('appScreen');
      localStorage.removeItem('appScreen');
    }
  }, [screen]);

  // Subscribe to AG-UI agent messages and sync to active localStorage session in real-time
  useEffect(() => {
    // Sync initial messages if any
    setMessages(agent.messages);

    const subscription = agent.subscribe({
      onMessagesChanged: (params) => {
        setMessages([...params.messages]);

        // Real-time save of streaming changes to localStorage using the synchronous session ref
        const currentActiveId = activeSessionIdRef.current;
        if (currentActiveId) {
          const convId = agent.getConversationId();
          setSessions(prevSessions => {
            const updated = prevSessions.map(s => {
              if (s.id === currentActiveId) {
                return {
                  ...s,
                  messages: [...params.messages],
                  conversationId: convId || s.conversationId
                };
              }
              return s;
            });
            localStorage.setItem("arg_chat_sessions", JSON.stringify(updated));
            return updated;
          });
        }
      },
      onRunFailed: (params) => {
        setErrorMessage(params.error?.message || "Generation failed.");
        setIsGenerating(false);
      },
      onRunFinalized: () => {
        setIsGenerating(false);

        // Final save of conversation ID returned from Dify
        const currentActiveId = activeSessionIdRef.current;
        if (currentActiveId) {
          const convId = agent.getConversationId();
          setSessions(prevSessions => {
            const updated = prevSessions.map(s => {
              if (s.id === currentActiveId) {
                return {
                  ...s,
                  conversationId: convId || s.conversationId
                };
              }
              return s;
            });
            localStorage.setItem("arg_chat_sessions", JSON.stringify(updated));
            return updated;
          });
        }
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [agent]);

  // Scroll to bottom of the chat list directly inside the isolated scroll viewport (prevents body pushing issues)
  useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTo({
        top: scrollContainerRef.current.scrollHeight,
        behavior: "smooth"
      });
    }
  }, [messages, isGenerating]);

  // Switch to a selected chat history session
  const selectSession = (sessionId: string) => {
    const session = sessions.find(s => s.id === sessionId);
    if (session) {
      changeActiveSessionId(sessionId);
      setMessages(session.messages);

      // Load selected state into the active agent instance
      agent.setConversationId(session.conversationId);
      agent.setMessages(session.messages);
      setErrorMessage("");
    }
  };

  // Delete a chat history session
  const deleteSession = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation(); // Prevent selectSession click firing

    const updated = sessions.filter(s => s.id !== sessionId);
    setSessions(updated);
    localStorage.setItem("arg_chat_sessions", JSON.stringify(updated));

    if (activeSessionIdRef.current === sessionId) {
      startNewChat();
    }
  };

  // Start a brand new, empty chat session
  const startNewChat = () => {
    changeActiveSessionId(null);
    agent.resetConversation();
    setMessages([]);
    setErrorMessage("");
    setIsGenerating(false);
  };

  // Handle sending message
  const handleSend = async (text: string) => {
    if (!text.trim() || isGenerating) return;

    setErrorMessage("");
    setIsGenerating(true);

    let currentSessionId = activeSessionId;

    try {
      // 1. If it is a completely brand new chat, initialize a dynamic localStorage session!
      if (!currentSessionId) {
        const newId = uuidv4();
        const cleanTitle = text.length > 25 ? text.substring(0, 25) + "..." : text;
        const newSession: ChatSession = {
          id: newId,
          title: cleanTitle,
          icon: "💬",
          conversationId: null,
          messages: [{ id: `msg_${uuidv4()}`, role: "user" as const, content: text }],
          createdAt: Date.now()
        };

        // Save session locally
        const updated = [newSession, ...sessions];
        setSessions(updated);
        localStorage.setItem("arg_chat_sessions", JSON.stringify(updated));

        // Mark as current active session
        changeActiveSessionId(newId);
        currentSessionId = newId;

        // Reset DifyAgent state to represent clean start
        agent.resetConversation();
      } else {
        // Update existing session locally first to show input immediately in viewport
        setSessions(prev => {
          const updated = prev.map(s => {
            if (s.id === currentSessionId) {
              return {
                ...s,
                messages: [...s.messages, { id: `msg_${uuidv4()}`, role: "user" as const, content: text }]
              };
            }
            return s;
          });
          localStorage.setItem("arg_chat_sessions", JSON.stringify(updated));
          return updated;
        });
      }

      // 2. Load latest session state into agent and add message
      agent.addMessage({
        id: `msg_${uuidv4()}`,
        role: "user" as const,
        content: text
      });

      // 3. Invoke Dify RAG endpoint (routed securely via backend proxy)
      await agent.runAgent();

    } catch (err: any) {
      console.error(err);
      setErrorMessage(err?.message || "An error occurred during run.");
      setIsGenerating(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend(inputValue);
      setInputValue("");
    }
  };

  // Convert complex content objects/arrays (from AG-UI Message interface) to safe strings
  const getMessageText = (content: any): string => {
    if (!content) return "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map(part => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && part.type === "text") return part.text || "";
        return "";
      }).join("");
    }
    return "";
  };

  // Premium ChatGPT Code Copy Handler
  const handleCopyCode = (codeText: string, elementId: string) => {
    navigator.clipboard.writeText(codeText);
    const btn = document.getElementById(elementId);
    if (btn) {
      btn.innerText = "Copied!";
      setTimeout(() => {
        btn.innerText = "Copy Code";
      }, 1500);
    }
  };

  // Elegant markdown formatter in React
  const formatMessageText = (text: string, messageId: string) => {
    if (!text) return "";

    const parts = text.split(/(```[\s\S]*?```)/g);

    return parts.map((part, index) => {
      // Code Block with Copier & Header
      if (part.startsWith("```") && part.endsWith("```")) {
        const lines = part.slice(3, -3).trim().split("\n");
        let language = "code";
        let codeContent = lines.join("\n");

        // Extract language if present
        if (lines[0] && lines[0].length < 15 && !lines[0].includes(" ") && !lines[0].includes("(") && !lines[0].includes("=")) {
          language = lines[0];
          codeContent = lines.slice(1).join("\n");
        }

        const buttonId = `copy_btn_${messageId}_${index}`;

        return (
          <div className="code-block" key={index} style={{ margin: "16px 0", borderRadius: "8px", overflow: "hidden", border: "1px solid rgba(255,255,255,0.06)", boxShadow: "0 4px 20px rgba(0,0,0,0.5)" }}>
            <div className="code-block-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#0a1120", padding: "8px 16px", fontSize: "0.7rem", color: "var(--text-muted)", textTransform: "uppercase", fontWeight: 700, borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
              <span>{language}</span>
              <button
                id={buttonId}
                onClick={() => handleCopyCode(codeContent, buttonId)}
                style={{ background: "transparent", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: "0.7rem", fontWeight: 700, padding: "2px 6px", borderRadius: "4px", transition: "all 0.2s" }}
                onMouseOver={(e) => (e.currentTarget.style.color = "#ffffff")}
                onMouseOut={(e) => (e.currentTarget.style.color = "var(--text-secondary)")}
              >
                Copy Code
              </button>
            </div>
            <pre className="code-block-body" style={{ margin: 0, padding: "16px", background: "#03060c", overflowX: "auto", fontSize: "0.82rem", fontFamily: "var(--font-mono)", lineHeight: 1.5, color: "#e2e8f0" }}>
              <code style={{ background: "transparent", padding: 0, fontSize: "inherit", color: "inherit", fontFamily: "inherit" }}>{codeContent}</code>
            </pre>
          </div>
        );
      }

      // Inline formatting (bold, list items, inline code)
      const lines = part.split("\n");
      return lines.map((line, lineIdx) => {
        let renderedLine: React.ReactNode = line;

        // Bullets
        if (line.trim().startsWith("- ") || line.trim().startsWith("* ")) {
          const bulletText = line.trim().substring(2);
          renderedLine = <li key={lineIdx}>{formatInlineStyles(bulletText)}</li>;
        } else if (/^\d+\.\s/.test(line.trim())) {
          const numText = line.trim().replace(/^\d+\.\s/, "");
          renderedLine = <li key={lineIdx} style={{ listStyleType: "decimal" }}>{formatInlineStyles(numText)}</li>;
        } else {
          renderedLine = <p key={lineIdx} style={{ marginBottom: "12px" }}>{formatInlineStyles(line)}</p>;
        }

        return renderedLine;
      });
    });
  };

  // Format bold (**text**) and inline code (`code`)
  const formatInlineStyles = (line: string) => {
    if (!line) return "";

    const regex = /(\*\*.*?\*\*|`.*?`)/g;
    const tokens = line.split(regex);

    return tokens.map((token, index) => {
      if (token.startsWith("**") && token.endsWith("**")) {
        return <strong key={index} style={{ fontWeight: 700, color: "#fff" }}>{token.slice(2, -2)}</strong>;
      }
      if (token.startsWith("`") && token.endsWith("`")) {
        return <code key={index} style={{ fontFamily: "var(--font-mono)", background: "rgba(255,255,255,0.08)", padding: "2px 6px", borderRadius: "4px", fontSize: "0.82rem" }}>{token.slice(1, -1)}</code>;
      }
      return token;
    });
  };

  // Simple validators
  const validateEmail = (e: string) => /\S+@\S+\.\S+/.test(e);

  const handleLogin = async () => {
    setAuthError('');
    if (!validateEmail(email)) {
      setAuthError('Please enter a valid email address.');
      return;
    }
    if (password.length < 6) {
      setAuthError('Password must be at least 6 characters.');
      return;
    }

    setIsLoggingIn(true);
    try {
      const response = await loginUser(email, password, 3);
      const token = (response as any)?.token;
      const userData = (response as any)?.user ?? null;

      if (token) {
        sessionStorage.setItem('accessToken', token);
        localStorage.setItem('accessToken', token);
      }
      if (userData) {
        sessionStorage.setItem('user', JSON.stringify(userData));
        localStorage.setItem('user', JSON.stringify(userData));
        setUser(userData);
        setIsAuthenticated(true);
      }

      if (!userData?.Haslawportalsubfee) {
        navigateTo('packages');
      } else {
        navigateTo('chat');
      }

    } catch (error: unknown) {
      setAuthError(error instanceof Error ? error.message : 'Login failed.');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleSignup = async () => {
    setAuthError('');
    if (!validateEmail(email)) {
      setAuthError('Please enter a valid email address.');
      return;
    }
    if (password.length < 6) {
      setAuthError('Password must be at least 6 characters.');
      return;
    }

    if (password !== confirmPassword) {
      setAuthError('Password and confirm password do not match.');
      return;
    }

    setIsLoggingIn(true);
    try {
      // If you have a registration endpoint, enable it here.
      // const formData = new FormData();
      // formData.append('Email', email);
      // formData.append('Password', password);
      // if (phone) formData.append('PhoneNumber', phone);
      // await registerUser(formData);

      navigateTo('packages');
    } catch (error: unknown) {
      setAuthError(error instanceof Error ? error.message : 'Signup failed.');
    } finally {
      setIsLoggingIn(false);
    }
  };



  const handlePayNow = () => {
    // Minimal simulated payment flow — after payment go to chat screen
    navigateTo('chat');
  };

  // Top-level UI flow: if not yet in chat, show auth / packages / payment screens
  if (isRestoring) {
    return null;
  }

  if (screen !== 'chat') {
    return (
      <div style={{ position: 'relative', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f4f6f9', padding: '120px 24px 40px' }}>
        {showNavbar && (
          <div style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 28px', background: 'rgba(255,255,255,0.70)', backdropFilter: 'blur(18px)', borderBottom: '1px solid rgba(15,23,42,0.08)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {showBack && (
                <button onClick={handleBack} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#0b69ff', fontSize: 14, fontWeight: 700 }}>← Back</button>
              )}
            </div>
            <div style={{ color: '#475569', fontWeight: 700, letterSpacing: '0.04em' }}>ARG LAW PORTAL</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, position: 'relative' }}>
              <button onClick={() => setShowProfileMenu(!showProfileMenu)} style={{ width: 38, height: 38, borderRadius: 19, background: '#eef2ff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, color: '#0b69ff', fontSize: 14, border: 'none', cursor: 'pointer' }}>
                {getDisplayName().charAt(0) || 'A'}
              </button>
              {showProfileMenu && (
                <div style={{ position: 'absolute', top: 'calc(100% + 8px)', right: 0, background: '#fff', border: '1px solid #eef2f6', borderRadius: 10, padding: 10, boxShadow: '0 8px 30px rgba(15,23,42,0.08)', minWidth: 150 }}>
                  <div style={{ marginBottom: 10, color: '#475569', fontWeight: 700 }}>Signed in as</div>
                  <div style={{ marginBottom: 12, color: '#64748b', fontSize: 13, wordBreak: 'break-all' }}>{getDisplayName()}</div>
                  <button onClick={handleLogout} style={{ width: '100%', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, color: '#0b69ff', padding: '8px 10px', cursor: 'pointer', fontWeight: 700 }}>Logout</button>
                </div>
              )}
            </div>
          </div>
        )}

        <div style={{ width: '100%', maxWidth: 1100, minHeight: 'calc(100vh - 180px)', background: '#fff', borderRadius: 20, boxShadow: '0 16px 60px rgba(16,24,40,0.12)', padding: '40px 36px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, marginBottom: 24, textAlign: 'center' }}>
            <img src="/Logo.svg" alt="ARG Logo" style={{ height: 56, width: 56 }} />
            <div>
              <h2 style={{ margin: 0, fontSize: 36, letterSpacing: '0.02em' }}>ARG LAW PORTAL</h2>
              <div style={{ fontSize: 15, color: '#6b7280', marginTop: 8 }}>Secure legal advisory portal</div>
            </div>
          </div>

          {screen === 'login' && (
            <div style={{ maxWidth: 420, margin: '0 auto', textAlign: 'center' }}>
              <div style={{ padding: '28px 24px 16px', background: '#fff', borderRadius: 16, boxShadow: '0 20px 60px rgba(15, 23, 42, 0.08)', marginBottom: 24 }}>
                <img src="/Logo.svg" alt="ARG Logo" style={{ width: 72, height: 72, margin: '0 auto 18px', display: 'block' }} />
                <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>ARG LAW PORTAL</div>
                <div style={{ color: '#6b7280', fontSize: 13, marginBottom: 22 }}>Sign in to your account</div>
                <div style={{ display: 'grid', gap: 14 }}>
                  <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email Address" style={{ width: '100%', padding: '14px 16px', borderRadius: 12, border: '1px solid #e5e7eb', fontSize: 14, outline: 'none' }} />
                  <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" type="password" style={{ width: '100%', padding: '14px 16px', borderRadius: 12, border: '1px solid #e5e7eb', fontSize: 14, outline: 'none' }} />
                  <button onClick={handleLogin} disabled={isLoggingIn} style={{ width: '100%', background: '#0b69ff', color: '#fff', padding: '14px 0', borderRadius: 12, border: 'none', fontSize: 15, fontWeight: 600, cursor: isLoggingIn ? 'not-allowed' : 'pointer', opacity: isLoggingIn ? 0.7 : 1 }}>
                    {isLoggingIn ? 'Signing In…' : 'Sign In'}
                  </button>
                </div>
                {authError && <div style={{ color: '#dc2626', fontSize: 13, marginTop: 12 }}>{authError}</div>}
              </div>
              <div style={{ color: '#6b7280', fontSize: 13 }}>
                Don&apos;t have an account? <button onClick={() => navigateTo('signup')} style={{ background: 'transparent', border: 'none', color: '#0b69ff', cursor: 'pointer', fontWeight: 700, padding: 0 }}>Sign Up</button>
              </div>
              <button onClick={() => alert('Password reset flow not implemented in demo')} style={{ marginTop: 10, background: 'transparent', border: 'none', color: '#6b7280', cursor: 'pointer', textDecoration: 'underline', fontSize: 13 }}>Forgot password?</button>
            </div>
          )}

          {screen === 'signup' && (
            <div style={{ maxWidth: 420, margin: '0 auto', textAlign: 'center' }}>
              <div style={{ padding: '24px', background: '#fff', borderRadius: 12, boxShadow: '0 16px 40px rgba(15, 23, 42, 0.06)', marginBottom: 18 }}>
                <img src="/Logo.svg" alt="Logo" style={{ width: 64, height: 64, margin: '0 auto 12px', display: 'block' }} />
                <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>ARG LAW PORTAL</div>
                <div style={{ color: '#6b7280', fontSize: 13, marginBottom: 16 }}>Create Your Account</div>

                <div style={{ display: 'grid', gap: 12 }}>
                  <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email Address *" style={{ width: '100%', padding: 12, borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 14 }} />
                  <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone Number (Optional)" style={{ width: '100%', padding: 12, borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 14 }} />

             

                  <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password *" type="password" style={{ width: '100%', padding: 12, borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 14 }} />
                  <input value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Confirm Password *" type="password" style={{ width: '100%', padding: 12, borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 14 }} />

                  <button onClick={handleSignup} disabled={isLoggingIn} style={{ width: '100%', background: '#0b69ff', color: '#fff', padding: '12px 0', borderRadius: 8, border: 'none', fontSize: 15, fontWeight: 700, cursor: isLoggingIn ? 'not-allowed' : 'pointer', opacity: isLoggingIn ? 0.7 : 1 }}>
                    {isLoggingIn ? 'Signing Up…' : 'Sign Up'}
                  </button>
                </div>
                {authError && <div style={{ color: '#dc2626', fontSize: 13, marginTop: 12 }}>{authError}</div>}
              </div>

              <div style={{ fontSize: 13, color: '#6b7280' }}>
                Already have an account? <button onClick={() => navigateTo('login')} style={{ background: 'transparent', border: 'none', color: '#0b69ff', cursor: 'pointer', fontWeight: 700, padding: 0 }}>Sign In</button>
              </div>
            </div>
          )}

          {screen === 'packages' && (
            <div>
              <h3 style={{ marginBottom: 8 }}>Select a package</h3>
              <div style={{ display: 'flex', gap: 16, marginTop: 12 }}>
                {[{amt:1000, services:3},{amt:2000, services:5},{amt:3000, services:8}].map(({amt, services}) => (
                  <div
                    key={amt}
                    onClick={() => { setSelectedPackage(amt); setPackageError(''); }}
                    style={{
                      flex: 1,
                      padding: 22,
                      borderRadius: 10,
                      border: amt === selectedPackage ? '1px solid #0b69ff' : '1px solid #eef2f6',
                      cursor: 'pointer',
                      textAlign: 'center',
                      background: '#fff',
                      transition: 'transform 180ms ease, box-shadow 180ms ease',
                      boxShadow: amt === selectedPackage ? '0 8px 30px rgba(11,105,255,0.08)' : '0 6px 18px rgba(15,23,42,0.03)'
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-6px)'; (e.currentTarget as HTMLDivElement).style.boxShadow = '0 18px 50px rgba(15,23,42,0.08)'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.transform = 'translateY(0)'; (e.currentTarget as HTMLDivElement).style.boxShadow = amt === selectedPackage ? '0 8px 30px rgba(11,105,255,0.08)' : '0 6px 18px rgba(15,23,42,0.03)'; }}
                  >
                    <div style={{ fontSize: 20, fontWeight: 800 }}>Rs. {amt.toLocaleString()}</div>
                    <div style={{ fontSize: 13, color: '#6b7280', marginTop: 6 }}>Package</div>

                    <div style={{ marginTop: 14, color: '#1f2937', fontWeight: 600 }}>{services} Services</div>
                    <div style={{ fontSize: 13, color: '#6b7280', marginTop: 8 }}>Includes core legal advisory items</div>

                    <div style={{ marginTop: 14 }}>
                      <button style={{ padding: '8px 12px', background: amt === selectedPackage ? '#0b69ff' : '#eef2ff', color: amt === selectedPackage ? '#fff' : '#0b69ff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>{amt === selectedPackage ? 'Selected' : 'Select'}</button>
                    </div>
                  </div>
                ))}
              </div>

              {packageError && <div style={{ color: '#dc2626', marginTop: 12 }}>{packageError}</div>}

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 18 }}>
                <button onClick={() => { if (!selectedPackage) { setPackageError('Please select a package to continue.'); return; } navigateTo('payment'); }} style={{ padding: '10px 18px', background: '#0b69ff', color: '#fff', border: 'none', borderRadius: 10 }}>Next</button>
              </div>
            </div>
          )}

          {screen === 'payment' && (
            <div>
              <h3 style={{ textAlign: 'center' }}>Select Payment Method</h3>
              <p style={{ textAlign: 'center', color: '#6b7280' }}>Choose your preferred way to pay the registration fee of Rs. {selectedPackage ?? '0'}</p>

              <div style={{ display: 'flex', gap: 18, marginTop: 12 }}>
                <div style={{ flex: 2 }}>
                  <div style={{ padding: 12, borderRadius: 8, border: `1px solid ${paymentMethod === 'bank' ? '#0b69ff' : '#e6edf6'}`, background: paymentMethod === 'bank' ? '#f0f8ff' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }} onClick={() => setPaymentMethod('bank')}>
                    <div>
                      <strong>Bank Alfalah Gateway</strong>
                      <div style={{ fontSize: 13, color: '#6b7280' }}>Pay securely using your credit/debit card or bank account</div>
                    </div>
                    <input type="radio" checked={paymentMethod === 'bank'} readOnly />
                  </div>

                  <div style={{ padding: 12, borderRadius: 8, border: `1px solid ${paymentMethod === 'jazz' ? '#0b69ff' : '#e6edf6'}`, background: paymentMethod === 'jazz' ? '#f0f8ff' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }} onClick={() => setPaymentMethod('jazz')}>
                    <div>
                      <strong>JazzCash</strong>
                      <div style={{ fontSize: 13, color: '#6b7280' }}>Pay using your JazzCash wallet (Coming soon)</div>
                    </div>
                    <input type="radio" checked={paymentMethod === 'jazz'} readOnly />
                  </div>
                </div>

                <div style={{ flex: 1, border: '1px solid #eef2f6', borderRadius: 10, padding: 16, background: '#fff' }}>
                  <div style={{ fontWeight: 700, marginBottom: 8 }}>Order Summary</div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: '#6b7280' }}>
                    <div>Registration Fee</div>
                    <div>Rs. {selectedPackage ?? '0'}</div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: '#6b7280', marginTop: 6 }}>
                    <div>Processing Fee</div>
                    <div>Rs. 0.00</div>
                  </div>

                  <hr style={{ margin: '12px 0', border: 'none', borderTop: '1px solid #eef2f6' }} />

                  <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800, fontSize: 16 }}>
                    <div>Total Amount</div>
                    <div>Rs. {selectedPackage ?? '0'}</div>
                  </div>

                  <div style={{ marginTop: 12 }}>
                    <button onClick={handlePayNow} style={{ width: '100%', padding: '10px 12px', background: '#0b69ff', color: '#fff', border: 'none', borderRadius: 8 }}>Pay Now</button>
                    <button onClick={() => navigateTo('login')} style={{ marginTop: 8, width: '100%', padding: '10px 12px', background: 'transparent', color: '#0b69ff', border: '1px solid #e6edf6', borderRadius: 8 }}>Back to Login</button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      {/* Background Glowing Effects */}
      <div className="glow-orb orb-magenta"></div>
      <div className="glow-orb orb-navy"></div>

      {/* Sidebar Panel (ChatGPT Layout styled with ARG theme) */}
      <aside className="sidebar">
        <div className="brand-section">
          <img src="/Logo.svg" className="brand-logo-img" alt="Company Logo" />
          <div className="brand-title">
            <h1>ARG Corporate</h1>
            <span>Legal Intelligence</span>
          </div>
        </div>

        <button
          className="new-chat-button"
          onClick={startNewChat}
        >
          <span>✨ New Session</span>
          <span className="new-chat-icon">+</span>
        </button>

        <nav className="sidebar-nav">
          <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.5px", padding: "0 12px 8px 12px" }}>
            Advisory History
          </div>
          {sessions.length === 0 ? (
            <div style={{ padding: "16px 12px", fontSize: "0.75rem", color: "var(--text-muted)", textAlign: "center", fontStyle: "italic" }}>
              No recent advisories
            </div>
          ) : (
            sessions.map(session => (
              <div
                key={session.id}
                className={`session-item ${session.id === activeSessionId ? "active" : ""}`}
                onClick={() => selectSession(session.id)}
                style={{ position: "relative", display: "flex", justifyContent: "space-between", alignItems: "center" }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "10px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  <span className="session-icon">{session.icon}</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.title}</span>
                </div>

                {/* Purge Session Button */}
                <button
                  onClick={(e) => deleteSession(e, session.id)}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "rgba(255, 255, 255, 0.2)",
                    fontSize: "0.85rem",
                    cursor: "pointer",
                    padding: "2px 6px",
                    borderRadius: "4px",
                    transition: "all 0.2s"
                  }}
                  onMouseOver={(e) => (e.currentTarget.style.color = "#c00074")}
                  onMouseOut={(e) => (e.currentTarget.style.color = "rgba(255, 255, 255, 0.2)")}
                  title="Delete advisory"
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </nav>

        <div className="sidebar-footer">
          <div className="connection-status">
            <span className={`status-dot ${isGenerating ? "loading" : ""}`}></span>
            <span>{isGenerating ? "Query Routing..." : "ChatBot is Active"}</span>
          </div>
        </div>
      </aside>

      {/* Chat Area Panel (ChatGPT Style Workspace) */}
      <main className="chat-window">
        <header className="chat-header">
          <div style={{ display: 'flex', alignItems: 'center', width: '100%' }}>
            <div style={{ flex: 1 }}>
              <h2 style={{ margin: 0 }}>ARG Corporate AI</h2>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {showBack && <button onClick={handleBack} style={{ background: 'transparent', border: 'none', color: '#0b69ff', cursor: 'pointer' }}>← Back</button>}
              {isAuthenticated && (
                <div style={{ position: 'relative' }}>
                  <button onClick={() => setShowProfileMenu(!showProfileMenu)} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', border: 'none', cursor: 'pointer' }}>
                    <div style={{ width: 36, height: 36, borderRadius: 18, background: '#eef2ff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>{getDisplayName().charAt(0) || 'A'}</div>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>{getDisplayName()}</div>
                  </button>
                  {showProfileMenu && (
                    <div style={{ position: 'absolute', right: 0, marginTop: 8, background: '#fff', border: '1px solid #eef2f6', borderRadius: 8, padding: 8, boxShadow: '0 8px 30px rgba(15,23,42,0.06)' }}>
                      <button onClick={handleLogout} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#ef4444' }}>Logout</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Main Content Area: Centered Welcome Splash OR Scrolling Message Feed */}
        {messages.length === 0 ? (
          <div className="welcome-container">
            <div className="welcome-screen">
              <div className="welcome-logo-wrap">
                <img src="/Logo.svg" className="welcome-logo-svg" alt="Company Logo" />
              </div>
              <h3>ARG Corporate AI</h3>
              <p>
                Your secure AI partner for instant tax advisory, corporate filings, and strategic compliance support.
              </p>

              <div className="suggestions-grid">
                <div
                  className="suggestion-card"
                  onClick={() => {
                    handleSend("Can you analyze my tax notice risk score and draft an immediate compliance list?");
                  }}
                >
                  <h4>📄 Analyze Notice Risk</h4>
                  <p>Calculate exposure risk scores and statutory response templates.</p>
                </div>

                <div
                  className="suggestion-card"
                  onClick={() => {
                    handleSend("What are the primary SECP compliance filing requirements for a private limited company in Pakistan?");
                  }}
                >
                  <h4>💼 SECP Compliance Filing</h4>
                  <p>Identify active deadlines, Form 29 procedures, and fee schedules.</p>
                </div>

                <div
                  className="suggestion-card"
                  onClick={() => {
                    handleSend("Search appellate tribunal judgments on withholding tax and transfer pricing precedents.");
                  }}
                >
                  <h4>⚖️ Statutory Precedents</h4>
                  <p>Locate tribunal resolutions and statutory interpretations (1947-2026).</p>
                </div>

                <div
                  className="suggestion-card"
                  onClick={() => {
                    handleSend("Explain the multi-layer quality gate review system for corporate advisory deliverables.");
                  }}
                >
                  <h4>🔍 Review SOP Advisor</h4>
                  <p>Learn about ARG's rigorous 2-layer statutory review gates.</p>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <section className="messages-list" ref={scrollContainerRef}>
            {messages.map((msg) => {
              if (msg.role !== "user" && msg.role !== "assistant") return null;

              return (
                <div key={msg.id} className={`message-row ${msg.role}`}>
                  <div className="message-content-wrap">
                    <div className="message-avatar-wrap">
                      {msg.role === "user" ? (
                        "U"
                      ) : (
                        <svg className="assistant-avatar-svg" viewBox="0 0 591 649" xmlns="http://www.w3.org/2000/svg">
                          <g transform="matrix(0.16766,0,0,0.16766,-10,-35)">
                            <path d="M298.517,873.472C297.646,872.978 287.624,867.296 287.624,867.296C281.099,863.6 282.008,862.369 217.903,756.267C214.147,750.052 201.097,626.894 195.762,588.466C195.312,585.222 192.209,583.105 176.462,573.591C175.647,573.099 174.36,573.76 175.764,585.466C194.119,738.413 194.892,742.966 197.202,756.566C198.308,763.08 243.779,836.953 246.291,840.607C248.626,844.002 241.663,839.999 241.313,839.798C224.484,830.122 227.047,827.165 181.998,750.199C176.358,740.563 177.446,740.12 166.309,611.518C162.114,563.068 159.418,560.123 163.504,560.399C168.904,560.764 336.772,571.516 343.588,572.094C345.363,572.244 345.813,573.94 334.087,592.236C332.817,594.218 341.425,588.222 214.741,588.222C205.295,588.222 244.264,592.762 328.502,596.461C333.626,596.686 319.003,617.823 317.569,617.894C315.259,618.009 312.93,617.728 310.629,617.965C306.726,618.367 347.872,777.705 351.439,791.515C353.561,799.735 354.959,799.035 411.956,878.17C477.413,969.051 482.534,973.597 477.572,972.177C463.452,968.137 458.626,968.786 449.894,956.209C424.829,920.102 425.39,919.95 400.198,883.717C367.053,836.045 338.908,795.149 333.598,787.434C323.839,773.254 301.458,644.661 294.207,618.579C293.086,614.547 278.276,613.819 277.595,614.584C274.924,617.583 309.357,767.307 312.397,780.526C314.061,787.765 315.191,787.314 423.216,945.613C426.298,950.13 421.593,945.86 416.69,943.16C389.447,928.159 391.916,925.128 374.993,899.179C292.41,772.546 292.414,772.553 292.41,772.546C289.636,767.347 264.969,625.557 261.698,612.442C260.913,609.295 243.038,604.374 243.459,607.496C244.379,614.32 273.767,771.271 274.274,773.552C277.071,786.148 353.758,898.107 361.018,908.706C364.154,913.284 342.587,899.814 339.543,897.448C331.84,891.46 263.273,777.813 256.9,767.25C249.821,755.517 234.669,630.977 228.816,602.434C228.35,600.16 212.999,593.945 211.553,593.36C208.963,592.311 209.021,593.759 209.425,596.512C211.887,613.276 231.876,741.813 233.841,754.447C237.611,778.691 242.218,776.844 290.829,856.284C298.789,869.293 309.377,880.831 298.517,873.472Z" />
                          </g>
                        </svg>
                      )}
                    </div>
                    <div className="message-bubble">
                      {formatMessageText(getMessageText(msg.content), msg.id)}
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Stream / Generating state loading animation */}
            {isGenerating && (
              <div className="message-row assistant">
                <div className="message-content-wrap">
                  <div className="message-avatar-wrap">
                    <svg className="assistant-avatar-svg" viewBox="0 0 591 649" xmlns="http://www.w3.org/2000/svg">
                      <g transform="matrix(0.16766,0,0,0.16766,-10,-35)">
                        <path d="M298.517,873.472C297.646,872.978 287.624,867.296 287.624,867.296C281.099,863.6 282.008,862.369 217.903,756.267C214.147,750.052 201.097,626.894 195.762,588.466C195.312,585.222 192.209,583.105 176.462,573.591C175.647,573.099 174.36,573.76 175.764,585.466C194.119,738.413 194.892,742.966 197.202,756.566C198.308,763.08 243.779,836.953 246.291,840.607C248.626,844.002 241.663,839.999 241.313,839.798C224.484,830.122 227.047,827.165 181.998,750.199C176.358,740.563 177.446,740.12 166.309,611.518C162.114,563.068 159.418,560.123 163.504,560.399C168.904,560.764 336.772,571.516 343.588,572.094C345.363,572.244 345.813,573.94 334.087,592.236C332.817,594.218 341.425,588.222 214.741,588.222C205.295,588.222 244.264,592.762 328.502,596.461C333.626,596.686 319.003,617.823 317.569,617.894C315.259,618.009 312.93,617.728 310.629,617.965C306.726,618.367 347.872,777.705 351.439,791.515C353.561,799.735 354.959,799.035 411.956,878.17C477.413,969.051 482.534,973.597 477.572,972.177C463.452,968.137 458.626,968.786 449.894,956.209C424.829,920.102 425.39,919.95 400.198,883.717C367.053,836.045 338.908,795.149 333.598,787.434C323.839,773.254 301.458,644.661 294.207,618.579C293.086,614.547 278.276,613.819 277.595,614.584C274.924,617.583 309.357,767.307 312.397,780.526C314.061,787.765 315.191,787.314 423.216,945.613C426.298,950.13 421.593,945.86 416.69,943.16C389.447,928.159 391.916,925.128 374.993,899.179C292.41,772.546 292.414,772.553 292.41,772.546C289.636,767.347 264.969,625.557 261.698,612.442C260.913,609.295 243.038,604.374 243.459,607.496C244.379,614.32 273.767,771.271 274.274,773.552C277.071,786.148 353.758,898.107 361.018,908.706C364.154,913.284 342.587,899.814 339.543,897.448C331.84,891.46 263.273,777.813 256.9,767.25C249.821,755.517 234.669,630.977 228.816,602.434C228.35,600.16 212.999,593.945 211.553,593.36C208.963,592.311 209.021,593.759 209.425,596.512C211.887,613.276 231.876,741.813 233.841,754.447C237.611,778.691 242.218,776.844 290.829,856.284C298.789,869.293 309.377,880.831 298.517,873.472Z" />
                      </g>
                    </svg>
                  </div>
                  <div className="message-bubble" style={{ display: "flex", alignItems: "center" }}>
                    <div className="typing-indicator">
                      <div className="typing-dot"></div>
                      <div className="typing-dot"></div>
                      <div className="typing-dot"></div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {errorMessage && (
              <div className="message-row" style={{ justifyContent: "center" }}>
                <div className="error-banner">
                  ⚠️ Error routing query: {errorMessage}
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </section>
        )}

        {/* Input Panel Area */}
        <footer className="input-panel">
          <div className="input-container">
            <textarea
              className="chat-input"
              rows={1}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask anything about corporate law or notices..."
              disabled={isGenerating}
            />
            <button
              className="send-button"
              onClick={() => {
                handleSend(inputValue);
                setInputValue("");
              }}
              disabled={!inputValue.trim() || isGenerating}
            >
              <svg className="send-icon-svg" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
              </svg>
            </button>
          </div>
          <div className="input-footer-text">
            Protected by ARG Corporate Security Proxy Gateways. Statutory context indexed from FBR & SECP frameworks.
          </div>
        </footer>
      </main>
    </div>
  );
}
