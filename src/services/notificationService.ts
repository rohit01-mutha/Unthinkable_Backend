import { PrismaClient, OrderStatus } from '@prisma/client';
import nodemailer from 'nodemailer';

const prisma = new PrismaClient();

/**
 * Trigger an asynchronous customer email notification upon order status history changes.
 * This runs in a non-blocking background queue and logs failures without breaking main requests.
 */
export const sendHistoryNotification = (
  orderId: string,
  status: OrderStatus,
  notes: string | null
) => {
  // Fire-and-forget background resolution
  Promise.resolve().then(async () => {
    try {
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: { customer: true },
      });

      if (!order || !order.customer) {
        return;
      }

      const customerEmail = order.customer.email;
      const customerName = order.customer.name;

      // Filter out internal-only logs that aren't customer-facing transitions
      // "matches estimate" is purely system verification and skipped.
      if (status === OrderStatus.ASSIGNED && notes && notes.includes('matches estimate')) {
        return;
      }

      let subject = `Shipment Update: Order status is now ${status}`;
      let body = `Dear ${customerName},\n\nYour shipment with reference ID ${orderId.substring(0, 8)}... has been updated.`;

      if (status === OrderStatus.PLACED) {
        if (notes && notes.includes('rescheduled')) {
          subject = `Shipment Rescheduled: Order #${orderId.substring(0, 8)}...`;
          body = `Dear ${customerName},\n\nYour shipment has been successfully rescheduled.\n\nDetails: ${notes}\n\nThank you for choosing Last-Mile Delivery.`;
        } else {
          subject = `Shipment Created: Order #${orderId.substring(0, 8)}...`;
          body = `Dear ${customerName},\n\nYour delivery order has been successfully placed!\n\nPickup Pincode: ${order.pickupPincode}\nDrop Pincode: ${order.dropPincode}\nEstimated Charge: ₹${order.charge.toFixed(2)}\n\nWe will assign a delivery agent shortly.`;
        }
      } else if (status === OrderStatus.ASSIGNED) {
        if (notes && notes.includes('charge revised')) {
          subject = `Shipment Charge Revised: Order #${orderId.substring(0, 8)}...`;
          body = `Dear ${customerName},\n\nAt pickup, the dimensions of your package were verified and the delivery charge has been revised:\n\nDetails: ${notes}\n\nIf you have any questions, please reply to this email.`;
        } else {
          subject = `Agent Assigned: Order #${orderId.substring(0, 8)}...`;
          body = `Dear ${customerName},\n\nAn agent has been assigned to deliver your package!\n\nDetails: ${notes}\n\nYour agent will collect the package soon.`;
        }
      } else if (status === OrderStatus.PICKED_UP) {
        subject = `Package Picked Up: Order #${orderId.substring(0, 8)}...`;
        body = `Dear ${customerName},\n\nOur agent has successfully collected your package and is proceeding with the delivery.\n\nDetails: ${notes}`;
      } else if (status === OrderStatus.IN_TRANSIT) {
        subject = `Package In Transit: Order #${orderId.substring(0, 8)}...`;
        body = `Dear ${customerName},\n\nYour package is now in transit towards the delivery zone.\n\nDetails: ${notes}`;
      } else if (status === OrderStatus.OUT_FOR_DELIVERY) {
        subject = `Out for Delivery: Order #${orderId.substring(0, 8)}...`;
        body = `Dear ${customerName},\n\nYour package is out for delivery with our agent and will arrive shortly!\n\nDetails: ${notes}`;
      } else if (status === OrderStatus.DELIVERED) {
        subject = `Package Delivered: Order #${orderId.substring(0, 8)}...`;
        body = `Dear ${customerName},\n\nCongratulations! Your package has been successfully delivered.\n\nDetails: ${notes}\n\nThank you for shipping with us!`;
      } else if (status === OrderStatus.FAILED) {
        subject = `Delivery Failed: Order #${orderId.substring(0, 8)}...`;
        body = `Dear ${customerName},\n\nWe were unable to deliver your package:\n\nDetails: ${notes}\n\nYou can reschedule delivery up to 3 times through your Customer Dashboard panel.`;
      }

      // Check if real SMTP or email service API key is set up
      const apiKey = process.env.EMAIL_SERVICE_API_KEY;
      if (!apiKey || apiKey === 'dummy_api_key') {
        // Log simulated email send attempt
        console.log(`[Email Sent (Simulated)] To: ${customerEmail} | Subject: ${subject} | Body: ${body.replace(/\n/g, ' ')}`);
        return;
      }

      // Nodemailer configuration
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.mailtrap.io',
        port: parseInt(process.env.SMTP_PORT || '2525'),
        auth: {
          user: process.env.SMTP_USER || '',
          pass: process.env.SMTP_PASS || '',
        },
      });

      await transporter.sendMail({
        from: '"Last-Mile Delivery Service" <noreply@lastmiledelivery.com>',
        to: customerEmail,
        subject,
        text: body,
      });

      console.log(`[Email Sent (Real)] Successfully emailed customer ${customerEmail} for status ${status}.`);
    } catch (err: any) {
      console.error(`[Notification Failure] Failed to send email for order ${orderId}:`, err.message || err);
    }
  });
};
