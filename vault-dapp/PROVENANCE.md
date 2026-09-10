# Provenance

## The DARs

`vendor/` holds two built DARs from another repository; its own
[`PROVENANCE.md`](vendor/PROVENANCE.md) records the commit and the build.

## The shell

These modules were copied from [`dapp/frontend`](../dapp/frontend) rather than rewritten, because
the two apps share a look and neither owns the pattern:

```
src/components/{Button,Card,ConnectFace,CopyButton,FieldError,Loading,Spinner}.tsx
src/components/Toaster/{index,ToastRow}.tsx
src/hooks/{useConnectErrorToast,useParty}.ts
src/store/useVaultStore.ts        the epoch guard and the useVault shape, not the state
src/styles/tokens.css
src/utils/{amountErrorText,cn,errorText,toast}.ts
public/favicon.svg
```

`toast.ts` and `ToastRow` dropped the action link and its `ToastMeta`: this app has one page, so no
toast has anywhere to send the reader.

`EmptyState`, `ErrorScreen` and `TopBar` started as copies and were reworded and cut down: this
package ships no icons, no router-wide scroll restoration and no account popover.

Anything in `src/backend/` is this app's own: the vault's choreography has no counterpart in the
vesting dApp.
