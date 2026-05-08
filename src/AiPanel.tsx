import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  AiRequestSettings,
  ApiError,
  applyChatProposalWithSettings,
  ChatProposal,
  sendChatMessage,
} from './api';

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
};

type AiPanelProps = {
  projectId: string;
  activeTabId: string;
  selectedNodeIds: string[];
  visibleNodeIds: string[];
  openaiApiKey?: string;
  supermemoryApiKey?: string;
  notionApiKey?: string;
  notionParentId?: string;
  taskGraphMcpUrl?: string;
  supermemoryMcpUrl?: string;
  notionMcpUrl?: string;
  disabled?: boolean;
  onApplied: (project: unknown) => void;
};

const uid = () => `ai-${Math.random().toString(36).slice(2, 10)}`;

export function AiPanel({
  projectId,
  activeTabId,
  selectedNodeIds,
  visibleNodeIds,
  openaiApiKey,
  supermemoryApiKey,
  notionApiKey,
  notionParentId,
  taskGraphMcpUrl,
  supermemoryMcpUrl,
  notionMcpUrl,
  disabled = false,
  onApplied,
}: AiPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: uid(),
      role: 'assistant',
      content: 'Ask for a breakdown, a reflection, a graph update draft, or a state summary. I will use the current scope, selected nodes, and configured MCP integrations as context.',
    },
  ]);
  const [composer, setComposer] = useState('');
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isApplyingProposal, setIsApplyingProposal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<ChatProposal | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  const settings: AiRequestSettings = useMemo(
    () => ({
      openaiApiKey,
      supermemoryApiKey,
      notionApiKey,
      taskGraphMcpUrl,
      supermemoryMcpUrl,
      notionMcpUrl,
    }),
    [openaiApiKey, supermemoryApiKey, notionApiKey, taskGraphMcpUrl, supermemoryMcpUrl, notionMcpUrl],
  );

  useEffect(() => {
    const composerElement = composerRef.current;
    if (!composerElement) {
      return;
    }
    composerElement.style.height = '0px';
    const nextHeight = Math.min(composerElement.scrollHeight, 240);
    composerElement.style.height = `${Math.max(52, nextHeight)}px`;
  }, [composer]);

  const submitMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextMessage = composer.trim();
    if (!nextMessage || isSubmitting || disabled) {
      return;
    }

    setError(null);
    setIsSubmitting(true);
    setMessages((current) => [...current, { id: uid(), role: 'user', content: nextMessage }]);
    setComposer('');

    try {
      const response = await sendChatMessage({
        projectId,
        message: nextMessage,
        uiContext: {
          activeTabId,
          selectedNodeIds,
          visibleNodeIds,
        },
        settings,
      });
      setProposal(response.proposal);
      setMessages((current) => [...current, { id: uid(), role: 'assistant', content: response.response }]);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not reach the AI service.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const applyProposal = async () => {
    if (!proposal || isApplyingProposal) {
      return;
    }

    setError(null);
    setIsApplyingProposal(true);
    try {
      const response = await applyChatProposalWithSettings(proposal.proposalId, settings);
      onApplied(response.project);
      setMessages((current) => [
        ...current,
        {
          id: uid(),
          role: 'assistant',
          content: `Applied proposal "${proposal.summary}" to the workflow graph and evaluated memory policy.`,
        },
      ]);
      setProposal(null);
    } catch (error) {
      if (error instanceof ApiError) {
        setError(error.message);
      } else {
        setError(error instanceof Error ? error.message : 'Could not apply the proposal.');
      }
    } finally {
      setIsApplyingProposal(false);
    }
  };

  const isExpanded = isComposerFocused || composer.trim().length > 0 || isSubmitting || isApplyingProposal || messages.length > 1;

  return (
    <div className={['glass-panel ai-panel-shell ai-panel-shell--dock', isExpanded ? 'is-expanded' : ''].join(' ')}>
      <div className="ai-dialog-panel__scroll ai-panel-scroll ai-panel-scroll--dock">
        {messages.map((message) => (
          <div key={message.id} className={['ai-message', message.role === 'assistant' ? 'is-assistant' : 'is-user'].join(' ')}>
            <p className="muted">{message.content}</p>
          </div>
        ))}
        {proposal ? (
          <div className="ai-message is-assistant ai-message--action">
            <p className="muted">{proposal.summary}</p>
            <div className="ai-composer__actions">
              <button type="button" className="primary-action" onClick={applyProposal} disabled={isApplyingProposal}>
                {isApplyingProposal ? 'Applying...' : 'Apply'}
              </button>
            </div>
          </div>
        ) : null}
        {error ? (
          <div className="ai-message is-assistant ai-message--error">
            <p className="muted">{error}</p>
          </div>
        ) : null}
        {isSubmitting ? (
          <div className="ai-message is-assistant ai-message--pending">
            <p className="muted">Thinking…</p>
          </div>
        ) : null}
      </div>

      <form className="ai-composer ai-composer--dock" onSubmit={submitMessage}>
        <label className="glass-field ai-composer__field" aria-label="AI prompt">
          <textarea
            ref={composerRef}
            rows={1}
            value={composer}
            onChange={(event) => setComposer(event.target.value)}
            onFocus={() => setIsComposerFocused(true)}
            onBlur={() => setIsComposerFocused(false)}
            placeholder="Ask the assistant..."
            disabled={disabled || isSubmitting}
          />
        </label>
        <div className="ai-composer__actions">
          <button type="submit" className="primary-action" disabled={disabled || isSubmitting || composer.trim().length === 0}>
            {isSubmitting ? 'Sending...' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  );
}
