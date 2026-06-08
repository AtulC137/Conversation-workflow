import { MarkerType, type Edge, type Node } from "reactflow";

import type { NodeData } from "./types";
import { NO_RESPONSE_HANDLE } from "./types";



export const LOAN_REMINDER_TEMPLATE_ID = "wf-template-loan-reminder";



export const DEFAULT_WORKFLOW_CONTEXT = `You represent Bank of Maharashtra calling about a loan payment.

Customer name: Atul

Monthly payment this month: 8500 rupees

Remaining balance: 17000 rupees

Late payment fine: 1000 rupees

Due date: 10th June 2026`;



const INTRO_YES = "intro-r-yes";

const INTRO_NO = "intro-r-no";

const REMINDER_PAY = "reminder-r-pay";

const REMINDER_CANT = "reminder-r-cant";

const REMINDER_CONTINUE = "reminder-r-continue";

const QA_NO = "qa-r-no";



const marker = { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "#3f3f46" } as const;



export function createLoanReminderTemplate(): {

  nodes: Node<NodeData>[];

  edges: Edge[];

} {

  const nodes: Node<NodeData>[] = [

    {

      id: "start",

      type: "start",

      position: { x: 80, y: 220 },

      data: { title: "Start" },

    },

    {

      id: "conv-intro",

      type: "conversation",

      position: { x: 280, y: 220 },

      data: {

        title: "intro",

        message:

          "hii, i am susha! i want to talk to you about your loan payment, do you have time right now ?",

        responses: [

          {

            id: INTRO_YES,

            label: "Yes",

            examples: ["yes", "sure", "i have time"],

          },

          {

            id: INTRO_NO,

            label: "NO",

            examples: [

              "no",

              "not now",

              "i dont have time",

              "can we talk later",

              "call later",

              "talk later",

            ],

          },

        ],

        tone: "Professional",

        notes: "",

      },

    },

    {

      id: "conv-reminder",

      type: "conversation",

      position: { x: 560, y: 80 },

      data: {

        title: "reminder",

        message: "i called to just remind you about your loan mothly payment on this 10th of june.",

        responses: [

          {

            id: REMINDER_PAY,

            label: "ok i will pay",

            examples: ["ok i will pay", "yes i'll pay", "i will pay on 10th"],

          },

          {

            id: REMINDER_CANT,

            label: "no i cant pay on 10th",

            examples: ["no i cant pay on 10th", "i cant pay that day"],

          },

          {

            id: REMINDER_CONTINUE,

            label: "acknowledged",

            examples: ["alright", "okay", "ok", "got it", "sure", "theek hai", "achha"],

          },

        ],

        tone: "Professional",

        notes: "",

      },

    },

    {

      id: "userInput-payment",

      type: "userInput",

      position: { x: 840, y: 80 },

      data: {

        title: "Payment details",

        instruction:

          "From context, tell the customer their name, monthly payment amount, remaining balance, late payment fine, and due date.",

        waitForResponse: true,

        notes: "",

      },

    },

    {

      id: "qa-payment",

      type: "qa",

      position: { x: 1100, y: 80 },

      data: {

        title: "Q&A",

        message: "Do you have any questions about your payment?",

        responses: [

          {

            id: QA_NO,

            label: "no questions",

            examples: ["no", "no questions", "nothing", "that's all", "nahi"],

          },

        ],

        notes: "",

        silenceTimeoutSec: 4,

      },

    },

    {

      id: "conv-bye",

      type: "conversation",

      position: { x: 560, y: 360 },

      data: {

        title: "bye",

        message: "we will contact you soon later. bye have a nice day.",

        responses: [],

        tone: "Professional",

        notes: "",

      },

    },

    {

      id: "conv-byee",

      type: "conversation",

      position: { x: 1080, y: 40 },

      data: {

        title: "Byee",

        message: "have a nice day then bye",

        responses: [],

        tone: "Professional",

        notes: "",

      },

    },

    {

      id: "conv-warning",

      type: "conversation",

      position: { x: 840, y: 200 },

      data: {

        title: "warning",

        message: "you will be fined of you dont pay on time.",

        responses: [],

        tone: "Professional",

        notes: "",

      },

    },

    {

      id: "end-completed",

      type: "end",

      position: { x: 1320, y: 220 },

      data: { title: "End", status: "Completed" },

    },

  ];



  const edges: Edge[] = [

    {

      id: "e-start-intro",

      source: "start",

      target: "conv-intro",

      type: "smoothstep",

      markerEnd: marker,

    },

    {

      id: "e-intro-reminder",

      source: "conv-intro",

      target: "conv-reminder",

      sourceHandle: INTRO_YES,

      type: "smoothstep",

      markerEnd: marker,

    },

    {

      id: "e-intro-bye",

      source: "conv-intro",

      target: "conv-bye",

      sourceHandle: INTRO_NO,

      type: "smoothstep",

      markerEnd: marker,

    },

    {

      id: "e-reminder-byee",

      source: "conv-reminder",

      target: "conv-byee",

      sourceHandle: REMINDER_PAY,

      type: "smoothstep",

      markerEnd: marker,

    },

    {

      id: "e-reminder-warning",

      source: "conv-reminder",

      target: "conv-warning",

      sourceHandle: REMINDER_CANT,

      type: "smoothstep",

      markerEnd: marker,

    },

    {

      id: "e-reminder-userinput",

      source: "conv-reminder",

      target: "userInput-payment",

      sourceHandle: REMINDER_CONTINUE,

      type: "smoothstep",

      markerEnd: marker,

    },

    {

      id: "e-userinput-qa",

      source: "userInput-payment",

      target: "qa-payment",

      sourceHandle: "ai-out",

      type: "smoothstep",

      markerEnd: marker,

    },

    {

      id: "e-qa-byee",

      source: "qa-payment",

      target: "conv-byee",

      sourceHandle: QA_NO,

      type: "smoothstep",

      markerEnd: marker,

    },

    {

      id: "e-qa-silence-replay",

      source: "qa-payment",

      target: "qa-payment",

      sourceHandle: NO_RESPONSE_HANDLE,

      type: "smoothstep",

      markerEnd: marker,

    },

    {

      id: "e-bye-end",

      source: "conv-bye",

      target: "end-completed",

      sourceHandle: "ai-out",

      type: "smoothstep",

      markerEnd: marker,

    },

    {

      id: "e-byee-end",

      source: "conv-byee",

      target: "end-completed",

      sourceHandle: "ai-out",

      type: "smoothstep",

      markerEnd: marker,

    },

    {

      id: "e-warning-end",

      source: "conv-warning",

      target: "end-completed",

      sourceHandle: "ai-out",

      type: "smoothstep",

      markerEnd: marker,

    },

  ];



  return { nodes, edges };

}


