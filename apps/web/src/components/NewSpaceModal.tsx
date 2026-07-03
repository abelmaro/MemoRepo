import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api, type Space } from "../lib/api";
import { Modal } from "./Modal";

export function NewSpaceModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const mutation = useMutation({
    mutationFn: () => api<{ space: Space }>("/api/spaces", { method: "POST", body: JSON.stringify({ name }) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["spaces"] });
      onClose();
    }
  });

  return (
    <Modal title="New Space" onClose={onClose}>
      <form className="form-stack" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
        <label>
          <span>Name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        </label>
        <button className="primary-button" type="submit" disabled={!name.trim() || mutation.isPending}>
          <Plus size={18} />
          <span>Create space</span>
        </button>
      </form>
    </Modal>
  );
}
