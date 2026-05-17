// Animated neon aura background used on the guest screens.
export function AuraBackground() {
  return (
    <div
      class="fixed inset-0 -z-20 overflow-hidden pointer-events-none"
      style="background-color:#050510"
      aria-hidden="true"
    >
      <div
        class="absolute -top-[10%] -left-[10%] w-[70vw] h-[70vw] rounded-full blur-[100px] mix-blend-screen"
        style="background-color:rgba(255,20,147,0.3); animation: flow1 12s infinite ease-in-out;"
      />
      <div
        class="absolute top-[20%] -right-[20%] w-[80vw] h-[80vw] rounded-full blur-[120px] mix-blend-screen"
        style="background-color:rgba(138,43,226,0.3); animation: flow2 18s infinite ease-in-out reverse;"
      />
      <div
        class="absolute -bottom-[20%] left-[10%] w-[60vw] h-[60vw] rounded-full blur-[90px] mix-blend-screen"
        style="background-color:rgba(0,255,255,0.2); animation: flow1 15s infinite ease-in-out 2s;"
      />
      <div
        class="absolute inset-0"
        style="background-image: linear-gradient(rgba(255,255,255,0.03) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.03) 1px,transparent 1px); background-size: 32px 32px;"
      />
    </div>
  );
}
