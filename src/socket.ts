import { Server as SocketIOServer } from 'socket.io';

let io: SocketIOServer | null = null;

export function setIO(server: SocketIOServer): void {
  io = server;
}

export function getIO(): SocketIOServer | null {
  return io;
}

export function emitOrderCreated(order: unknown): void {
  io?.emit('order_created', order);
}

export function emitOrderStatusUpdated(order: unknown): void {
  io?.emit('order_status_updated', order);
}
