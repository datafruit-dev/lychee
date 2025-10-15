"use client";

import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

const MarkdownRenderer = memo(function MarkdownRenderer({ content, className = '' }: MarkdownRendererProps) {
  return (
    <div className={`markdown-content ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Style headings
          h1: ({ children }) => <h1 className="font-bold text-lg mb-2 text-foreground">{children}</h1>,
          h2: ({ children }) => <h2 className="font-semibold text-base mb-2 text-foreground">{children}</h2>,
          h3: ({ children }) => <h3 className="font-medium text-sm mb-1 text-foreground">{children}</h3>,

          // Style paragraphs
          p: ({ children }) => <p className="text-[15px] mb-2 text-foreground break-words leading-relaxed">{children}</p>,

          // Style lists
          ul: ({ children }) => <ul className="list-disc list-inside text-[15px] mb-2 text-foreground space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal list-inside text-[15px] mb-2 text-foreground space-y-1">{children}</ol>,
          li: ({ children }) => <li className="text-[15px] text-foreground">{children}</li>,

          // Style links
          a: ({ href, children }) => (
            <a href={href} className="text-[15px] text-primary hover:text-primary/80 underline" target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),

          // Style inline code and code blocks
          code: ({ className, children, ...props }: React.ComponentPropsWithoutRef<'code'> & { className?: string }) => {
            const match = /language-(\w+)/.exec(className || '');
            const language = match ? match[1] : '';

            // Check if this is a code block (has newlines) vs inline code
            const isCodeBlock = typeof children === 'string' && children.includes('\n');

            if (className && className.startsWith('language-')) {
              // Only treat as code block if it has a specified language
              if (match && language) {
                // Normalize language names
                const normalizedLanguage = language === 'py' ? 'python' :
                                         language === 'terraform' ? 'hcl' :
                                         language === 'sh' ? 'bash' :
                                         language === 'js' ? 'javascript' :
                                         language;

                // Use syntax highlighting for supported languages
                const shouldHighlight = [
                  'hcl', 'python', 'terraform', 'bash', 'shell',
                  'javascript', 'js', 'json', 'yaml', 'yml',
                  'typescript', 'ts', 'go', 'rust', 'c', 'cpp',
                  'java', 'sql', 'css', 'html', 'xml', 'markdown', 'md'
                ].includes(normalizedLanguage);

                if (shouldHighlight) {
                  return (
                    <div className="markdown-codeblock">
                      <div className="markdown-codeblock-container">
                        <div className="markdown-codeblock-header">
                          {normalizedLanguage}
                        </div>
                        <SyntaxHighlighter
                          // eslint-disable-next-line @typescript-eslint/no-explicit-any
                          style={oneLight as any}
                          language={normalizedLanguage}
                          PreTag="div"
                          customStyle={{
                            fontSize: '14px',
                            margin: 0,
                            padding: '20px 24px',
                            lineHeight: '1.6',
                            background: 'transparent',
                            borderRadius: 0,
                          }}
                          {...props}
                        >
                          {String(children).replace(/\n$/, '')}
                        </SyntaxHighlighter>
                      </div>
                    </div>
                  );
                }

                // For other specified languages, use plain code styling
                return (
                  <div className="markdown-codeblock">
                    <div className="markdown-codeblock-container">
                      <div className="markdown-codeblock-header">
                        {language}
                      </div>
                      <div className="markdown-codeblock-content">
                        <code className="markdown-codeblock-code">
                          {String(children).replace(/\n$/, '')}
                        </code>
                      </div>
                    </div>
                  </div>
                );
              }

              // No language specified - treat as code block with plain styling
              return (
                <div className="markdown-codeblock">
                  <div className="markdown-codeblock-container">
                    <div className="markdown-codeblock-header">
                      code
                    </div>
                    <div className="markdown-codeblock-content">
                      <code className="markdown-codeblock-code">
                        {String(children).replace(/\n$/, '')}
                      </code>
                    </div>
                  </div>
                </div>
              );
            }

            // Handle plain code blocks (no language specified)
            if (isCodeBlock) {
              return (
                <div className="markdown-codeblock">
                  <div className="markdown-codeblock-container">
                    <div className="markdown-codeblock-content">
                      <code className="markdown-codeblock-code">
                        {String(children).replace(/\n$/, '')}
                      </code>
                    </div>
                  </div>
                </div>
              );
            }

            // Inline code
            return (
              <code className="bg-gray-100 px-2 py-1 text-[14px] text-gray-900 rounded" style={{ fontFamily: 'var(--font-geist-mono)' }} {...props}>
                {children}
              </code>
            );
          },

          // Style blockquotes
          blockquote: ({ children }) => (
            <blockquote className="border-l-4 border-gray-400 pl-4 text-[15px] text-gray-600 italic mb-2">
              {children}
            </blockquote>
          ),

          // Style tables
          table: ({ children }) => (
            <div className="overflow-x-auto my-4">
              <table className="min-w-full border border-gray-300 text-[15px]">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-gray-300 px-3 py-2 bg-gray-50 font-medium text-gray-900 text-[15px]">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-gray-300 px-3 py-2 text-gray-900 text-[15px]">
              {children}
            </td>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

export default MarkdownRenderer;
