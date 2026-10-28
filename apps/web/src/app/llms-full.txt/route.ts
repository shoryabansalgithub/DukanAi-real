import { llmsFullTxt, MARKDOWN_HEADERS } from '@/marketing/llms';

export const dynamic = 'force-dynamic';

export function GET() {
  return new Response(llmsFullTxt(), { headers: { ...MARKDOWN_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' } });
}
