'use client';

import { useState, useCallback } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Tick01Icon } from '@hugeicons/core-free-icons';

export interface CommandSelectOption {
  value: string;
  label: string;
  description?: string;
  /** Sub-options shown after selecting this option (e.g. reasoning effort for Codex models) */
  subOptions?: { value: string; label: string }[];
  /** Default sub-option value */
  defaultSubOption?: string;
}

export interface CommandSelectData {
  /** Base command e.g. "/model" or "/permissions" */
  command: string;
  /** Display title */
  title: string;
  /** Currently active value */
  current?: string;
  /** Selectable options */
  options: CommandSelectOption[];
  /** Session and engine context */
  sessionId: string;
  engineType: string;
}

/**
 * Renders an inline interactive picker in the chat message area.
 * Dispatches a 'command-rerun' CustomEvent when the user makes a selection,
 * which ChatView / page.tsx listens for and routes through handleCommand.
 */
export function CommandSelectBlock({ data }: { data: CommandSelectData }) {
  const [selectedValue, setSelectedValue] = useState<string | null>(null);
  const [selectedSub, setSelectedSub] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const dispatchCommand = useCallback((fullArgs: string) => {
    window.dispatchEvent(new CustomEvent('command-rerun', {
      detail: { command: `${data.command} ${fullArgs}` },
    }));
  }, [data.command]);

  const handleOptionClick = useCallback((option: CommandSelectOption) => {
    if (done) return;
    // If option has sub-options, show step 2
    if (option.subOptions && option.subOptions.length > 0) {
      setSelectedValue(option.value);
      return;
    }
    // No sub-options → execute directly
    setSelectedValue(option.value);
    setDone(true);
    dispatchCommand(option.value);
  }, [done, dispatchCommand]);

  const handleSubOptionClick = useCallback((subValue: string) => {
    if (done || !selectedValue) return;
    setSelectedSub(subValue);
    setDone(true);
    dispatchCommand(`${selectedValue} ${subValue}`);
  }, [done, selectedValue, dispatchCommand]);

  const activeSubOptions = selectedValue && !done
    ? data.options.find(o => o.value === selectedValue)?.subOptions
    : null;

  return (
    <div className="my-3 space-y-2">
      <p className="text-sm font-medium text-foreground">{data.title}</p>

      {/* Main options */}
      <div className="flex flex-wrap gap-1.5">
        {data.options.map(option => {
          const isCurrent = option.value === data.current;
          const isSelected = option.value === selectedValue;

          return (
            <button
              key={option.value}
              type="button"
              onClick={() => handleOptionClick(option)}
              disabled={done || (!!selectedValue && !isSelected)}
              className={[
                'inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border transition-all duration-150',
                isSelected && done
                  ? 'bg-primary text-primary-foreground border-primary'
                  : isSelected && !done
                    ? 'bg-accent border-primary/50 text-accent-foreground ring-1 ring-primary/30'
                    : isCurrent
                      ? 'bg-accent/60 border-accent-foreground/20 text-accent-foreground'
                      : 'bg-background border-border hover:bg-accent hover:text-accent-foreground',
                (done || (selectedValue && !isSelected)) ? 'opacity-40 cursor-default' : 'cursor-pointer',
              ].join(' ')}
            >
              {isSelected && done && (
                <HugeiconsIcon icon={Tick01Icon} className="h-3.5 w-3.5" />
              )}
              <span>{option.label}</span>
              {isCurrent && !isSelected && (
                <span className="text-xs text-muted-foreground/70">(current)</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Sub-options (step 2, e.g. reasoning effort) */}
      {activeSubOptions && activeSubOptions.length > 0 && (
        <div className="mt-2 space-y-1.5 pl-2 border-l-2 border-primary/30">
          <p className="text-xs text-muted-foreground">
            Select reasoning effort for <span className="font-medium text-foreground">{selectedValue}</span>:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {activeSubOptions.map(sub => {
              const isSubSelected = sub.value === selectedSub;
              const defaultSub = data.options.find(o => o.value === selectedValue)?.defaultSubOption;
              const isDefault = sub.value === defaultSub;

              return (
                <button
                  key={sub.value}
                  type="button"
                  onClick={() => handleSubOptionClick(sub.value)}
                  disabled={done}
                  className={[
                    'inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border transition-all duration-150',
                    isSubSelected
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-background border-border hover:bg-accent hover:text-accent-foreground',
                    done && !isSubSelected ? 'opacity-40 cursor-default' : 'cursor-pointer',
                  ].join(' ')}
                >
                  {isSubSelected && (
                    <HugeiconsIcon icon={Tick01Icon} className="h-3 w-3" />
                  )}
                  <span>{sub.label}</span>
                  {isDefault && !isSubSelected && (
                    <span className="text-muted-foreground/60">(default)</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Helpers for building command-select content ───────────────────────

/**
 * Build a command-select code block string to embed in a message's content.
 * MessageItem will detect and render it as an interactive CommandSelectBlock.
 */
export function buildCommandSelectContent(data: CommandSelectData): string {
  return '```command-select\n' + JSON.stringify(data) + '\n```';
}
