import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus } from "lucide-react";
import { api, type Space } from "../lib/api";
import { Modal } from "./Modal";

interface NewSpaceFormProps {
  inline?: boolean;
  onCreated: (space: Space) => void;
}

export function NewSpaceModal({ onClose, onCreated }: { onClose: () => void; onCreated: (space: Space) => void }) {
  return (
    <Modal title="New Space" onClose={onClose}>
      <NewSpaceForm onCreated={onCreated} />
    </Modal>
  );
}

export function NewSpaceForm({ inline = false, onCreated }: NewSpaceFormProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const mutation = useMutation({
    mutationFn: () => api<{ space: Space }>("/api/spaces", { method: "POST", body: JSON.stringify({ name }) }),
    onSuccess: ({ space }) => {
      queryClient.setQueryData<{ spaces: Space[] }>(["spaces"], (current) => ({ spaces: [...(current?.spaces ?? []), space] }));
      void queryClient.invalidateQueries({ queryKey: ["spaces"] });
      onCreated(space);
    }
  });

  return (
    <form
      className={inline ? "inline-form new-space-inline-form" : "form-stack"}
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate();
      }}
    >
      <label>
        <span className={inline ? "sr-only" : undefined}>Space name</span>
        <input
          data-modal-autofocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={inline ? "Space name, e.g. analytics" : undefined}
          autoFocus
        />
      </label>
      <button className="primary-button" type="submit" disabled={!name.trim() || mutation.isPending}>
        {mutation.isPending ? <Loader2 className="spin" size={18} /> : <Plus size={18} />}
        <span>Create Space</span>
      </button>
      {mutation.error ? (
        <div className="inline-alert error" role="alert">
          {mutation.error instanceof Error ? mutation.error.message : "The Space could not be created."}
        </div>
      ) : null}
    </form>
  );
}
