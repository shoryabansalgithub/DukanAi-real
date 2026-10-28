import Link from 'next/link';
import { parseInline, parseMarkdown, type Inline } from '@/marketing/markdown';

function InlineText({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((part, index) => {
        if (part.kind === 'strong') return <strong key={index} className="font-semibold text-slate-900">{part.text}</strong>;
        if (part.kind === 'code') {
          return (
            <code key={index} className="whitespace-nowrap rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[0.88em] text-slate-800">
              {part.text}
            </code>
          );
        }
        if (part.kind === 'link') {
          const external = /^https?:/.test(part.href);
          const className = 'font-medium text-indigo-700 underline decoration-indigo-300 underline-offset-2 hover:decoration-indigo-700';
          return external ? (
            <a key={index} href={part.href} className={className} rel="noopener">
              {part.text}
            </a>
          ) : (
            <Link key={index} href={part.href} className={className}>
              {part.text}
            </Link>
          );
        }
        return <span key={index}>{part.text}</span>;
      })}
    </>
  );
}

/** Inline Markdown (bold and links) inside an element the caller chooses. */
export function InlineMarkdown({ source }: { source: string }) {
  return <InlineText parts={parseInline(source)} />;
}

/** A page body in the subset of `marketing/markdown.ts`, styled for reading. */
export function Markdown({ source }: { source: string }) {
  return (
    <div className="space-y-5 text-[17px] leading-[1.7] text-slate-700">
      {parseMarkdown(source).map((block, index) => {
        switch (block.kind) {
          case 'h2':
            return (
              <h2 key={index} id={block.id} className="scroll-mt-24 pt-6 text-2xl font-bold tracking-tight text-slate-900">
                <InlineText parts={parseInline(block.text)} />
              </h2>
            );
          case 'h3':
            return (
              <h3 key={index} id={block.id} className="scroll-mt-24 pt-2 text-lg font-semibold text-slate-900">
                <InlineText parts={parseInline(block.text)} />
              </h3>
            );
          case 'p':
            return (
              <p key={index}>
                <InlineText parts={block.inline} />
              </p>
            );
          case 'ul':
            return (
              <ul key={index} className="list-disc space-y-2 pl-6 marker:text-indigo-400">
                {block.items.map((item, i) => (
                  <li key={i} className="pl-1">
                    <InlineText parts={item} />
                  </li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={index} className="list-decimal space-y-2 pl-6 marker:font-semibold marker:text-indigo-500">
                {block.items.map((item, i) => (
                  <li key={i} className="pl-1">
                    <InlineText parts={item} />
                  </li>
                ))}
              </ol>
            );
          case 'callout':
            return (
              <p key={index} className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 text-[15px] leading-relaxed text-amber-950">
                <InlineText parts={block.inline} />
              </p>
            );
          case 'table':
            return (
              <div key={index} className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
                <table className="w-full min-w-[520px] border-collapse text-left text-[15px] leading-snug">
                  <thead>
                    <tr className="border-b-2 border-slate-200">
                      {block.head.map((cell, i) => (
                        <th key={i} scope="col" className="py-3 pr-4 font-semibold text-slate-900">
                          <InlineText parts={cell} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr key={r} className="border-b border-slate-100 align-top">
                        {row.map((cell, c) => (
                          <td key={c} className={`py-3 pr-4 ${c === 0 ? 'font-medium text-slate-900' : ''}`}>
                            <InlineText parts={cell} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </div>
  );
}
