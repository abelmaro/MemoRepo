import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  a({ node, ...props }) {
    void node;
    return <a {...props} target="_blank" rel="noopener noreferrer" />;
  }
};

export function AgentMarkdown({ content }: { content: string }) {
  return (
    <div className="ask-space-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} disallowedElements={["img"]} skipHtml>
        {content}
      </ReactMarkdown>
    </div>
  );
}
