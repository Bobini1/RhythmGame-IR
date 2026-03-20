<script lang="ts">
  import Avatar from '$lib/components/avatar/avatar.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Camera, X } from '@lucide/svelte';
  import authClient from '$lib/client/auth/client';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';

  const session = authClient.useSession();

  let file = $state<File | null>(null);
  let preview = $state<string | null>(null);
  let isLoading = $state(false);
  let fileInput: HTMLInputElement | null = null;
  let fileName = $state<string | null>(null);
  let fileSize = $state<number | null>(null);

  function onFileChange(e: Event) {
    const input = e.target as HTMLInputElement;
    const newFile = input.files?.[0] ?? null;
    if (!newFile) {
      clearSelection();
      return;
    }

    if (!newFile.type.startsWith('image/')) {
      toast.error($t('common.invalid_image'));
      input.value = '';
      clearSelection();
      return;
    }

    if (newFile.size > 5 * 1024 * 1024) {
      toast.error($t('common.file_too_large'));
      input.value = '';
      clearSelection();
      return;
    }

    file = newFile;
    // revoke previous preview if any
    if (preview) URL.revokeObjectURL(preview);
    preview = URL.createObjectURL(newFile);
    fileName = newFile.name;
    fileSize = newFile.size;
  }

  function triggerFileSelect() {
    fileInput?.click();
  }

  function clearSelection() {
    if (preview) {
      URL.revokeObjectURL(preview);
    }
    file = null;
    preview = null;
    fileName = null;
    fileSize = null;
    if (fileInput) fileInput.value = '';
  }

  async function upload() {
    if (!file) {
      toast.error($t('common.select_file'));
      return;
    }
    if (!$session.data) {
      toast.error($t('common.not_authenticated'));
      return;
    }

    isLoading = true;
    try {
      // Request a presigned URL from server
      const res = await fetch('/api/uploads/profile-avatar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, contentType: file.type })
      });

      if (!res.ok) {
        toast.error($t('common.upload_error'));
        return;
      }

      const data = await res.json();
      const { url, publicUrl } = data as { url: string; publicUrl: string };

      // Upload file directly to presigned url
      const put = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file
      });

      if (!put.ok) {
        console.error('Upload failed', await put.text());
        toast.error($t('common.upload_error'));
        return;
      }

      // Update user profile image using auth client
      try {
        const result = await authClient.updateUser({ image: publicUrl });
        // better-auth clients often return an object with error property on failure
        if (result && result.error) {
          toast.error($t('common.update_profile_error'));
          return;
        }
      } catch (err) {
        console.error('Update user via auth client failed', err);
        toast.error($t('common.update_profile_error'));
        return;
      }

      toast.success($t('common.upload_success'));
      // Refresh page to pick up updated session/profile
      location.reload();
    } catch (err) {
      console.error(err);
      toast.error($t('common.upload_error'));
    } finally {
      isLoading = false;
    }
  }
</script>

<div class="rounded-lg border p-4">
  <div class="grid grid-cols-[auto_1fr] gap-4 items-start">
    <div class="relative">
      <!-- Avatar: show preview if selected, otherwise current user image -->
      <Avatar
        styleClass="h-20 w-20 rounded-full overflow-hidden"
        src={preview ?? $session.data?.user.image ?? undefined}
        id={$session.data?.user.id}
        size={80}
      />

      <!-- Camera overlay -->
      <button
        type="button"
        class="absolute -bottom-1 -right-1 bg-primary text-primary-foreground rounded-full p-1 shadow-md hover:bg-primary/90"
        onclick={triggerFileSelect}
        aria-label="Change avatar"
      >
        <Camera size={16} />
      </button>

      <!-- hidden native input -->
      <input
        bind:this={fileInput}
        class="hidden"
        type="file"
        accept="image/*"
        onchange={onFileChange}
      />
    </div>

    <div class="flex flex-col">
      <div class="flex items-center justify-between">
        <div>
          <div class="font-medium">{$t('common.profile_picture')}</div>
          <div class="text-sm text-muted-foreground">{$t('common.avatar_upload_help')}</div>
        </div>
      </div>

      {#if file}
        <div class="mt-4">
          <div class="flex items-center gap-3">
            <div class="min-w-0">
              <div class="font-medium truncate max-w-[24rem]">{fileName}</div>
              <div class="text-xs text-muted-foreground">{Math.round((fileSize ?? 0) / 1024)} KB</div>
            </div>
          </div>
        </div>

        <div class="mt-4 flex gap-2">
          <button type="button" class="flex items-center gap-2 px-3 py-1 rounded-md border" onclick={clearSelection} disabled={isLoading}>
            <X size={14} />
            <span class="text-sm">{$t('common.cancel')}</span>
          </button>

          <Button onclick={upload} disabled={isLoading}>
            {#if isLoading}
              <svg class="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" stroke-opacity="0.25"/><path d="M4 12a8 8 0 018-8" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>
            {:else}
              {$t('common.upload')}
            {/if}
          </Button>
        </div>
      {:else}
        <div class="mt-4">
          <Button variant="outline" onclick={triggerFileSelect} disabled={isLoading}>
            {$t('common.choose_file')}
          </Button>
        </div>
      {/if}
    </div>
  </div>
</div>



