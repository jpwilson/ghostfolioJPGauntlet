import { PortfolioService } from '@ghostfolio/api/app/portfolio/portfolio.service';
import { OrderService } from '@ghostfolio/api/app/order/order.service';
import { SymbolService } from '@ghostfolio/api/app/symbol/symbol.service';

import { Injectable } from '@nestjs/common';
import { openai } from '@ai-sdk/openai';
import { generateText, tool, CoreMessage } from 'ai';
import { z } from 'zod';

@Injectable()
export class AgentService {
  public constructor(
    private readonly portfolioService: PortfolioService,
    private readonly orderService: OrderService,
    private readonly symbolService: SymbolService
  ) {}

  public async chat({
    messages,
    userId
  }: {
    messages: CoreMessage[];
    userId: string;
  }) {
    // This is the ReAct loop. generateText with maxSteps lets the LLM
    // call tools, observe results, think, and call more tools — up to
    // maxSteps iterations. The LLM decides when it has enough info to
    // respond to the user.
    const result = await generateText({
      model: openai('gpt-4o-mini'),
      system: `You are a helpful financial assistant for Ghostfolio, a portfolio management app.
You help users understand their investments by analyzing their portfolio, looking up market data, and reviewing their transaction history.
Always be factual and precise with numbers. If you don't have enough data to answer, say so.
When discussing financial topics, include appropriate caveats that this is not financial advice.`,
      messages,
      tools: {
        // TOOL 1: Portfolio Summary
        // The LLM reads this description to decide when to call this tool.
        // This is why tool descriptions matter — they're prompts.
        portfolio_summary: tool({
          description:
            'Get the current portfolio holdings with allocation percentages, asset classes, and performance. Use this when the user asks about their portfolio, holdings, allocation, diversification, or how their investments are doing.',
          parameters: z.object({}),
          execute: async () => {
            try {
              const details = await this.portfolioService.getDetails({
                filters: [],
                impersonationId: undefined,
                userId
              });

              const holdings = Object.values(details.holdings).map(
                (holding) => ({
                  name: holding.name,
                  symbol: holding.symbol,
                  currency: holding.currency,
                  assetClass: holding.assetClass,
                  assetSubClass: holding.assetSubClass,
                  allocationInPercentage: (
                    holding.allocationInPercentage * 100
                  ).toFixed(2),
                  marketPrice: holding.marketPrice,
                  quantity: holding.quantity,
                  valueInBaseCurrency: holding.valueInBaseCurrency
                })
              );

              return {
                success: true,
                holdings,
                summary: details.summary
              };
            } catch (error) {
              return {
                success: false,
                error: `Failed to fetch portfolio: ${error.message}`
              };
            }
          }
        }),

        // TOOL 2: Market Data Lookup
        // Lets the agent look up current prices and info for any symbol.
        market_data: tool({
          description:
            'Look up current market data for a stock, ETF, or cryptocurrency by searching for its name or symbol. Use this when the user asks about current prices, what a stock is trading at, or wants to look up a specific asset.',
          parameters: z.object({
            query: z
              .string()
              .describe(
                'The stock symbol or company name to search for (e.g. "AAPL", "Apple", "VTI")'
              )
          }),
          execute: async ({ query }) => {
            try {
              const result = await this.symbolService.lookup({
                query,
                user: { id: userId, settings: { settings: {} } } as any
              });

              if (!result?.items?.length) {
                return {
                  success: false,
                  error: `No results found for "${query}"`
                };
              }

              return {
                success: true,
                results: result.items.slice(0, 5).map((item) => ({
                  symbol: item.symbol,
                  name: item.name,
                  currency: item.currency,
                  dataSource: item.dataSource,
                  assetClass: item.assetClass,
                  assetSubClass: item.assetSubClass
                }))
              };
            } catch (error) {
              return {
                success: false,
                error: `Failed to look up symbol: ${error.message}`
              };
            }
          }
        }),

        // TOOL 3: Transaction History
        // Fetches the user's buy/sell/dividend activity.
        transaction_history: tool({
          description:
            'Get the user\'s recent transaction history (buys, sells, dividends, fees). Use this when the user asks about their past trades, activity, transaction patterns, or what they have bought or sold recently.',
          parameters: z.object({
            limit: z
              .number()
              .optional()
              .default(20)
              .describe('Maximum number of transactions to return')
          }),
          execute: async ({ limit }) => {
            try {
              const { activities } =
                await this.orderService.getOrders({
                  filters: [],
                  userCurrency: 'USD',
                  userId,
                  withExcludedAccountsAndActivities: false
                });

              const recentActivities = activities
                .sort(
                  (a, b) =>
                    new Date(b.date).getTime() - new Date(a.date).getTime()
                )
                .slice(0, limit)
                .map((activity) => ({
                  date: activity.date,
                  type: activity.type,
                  symbol: activity.SymbolProfile?.symbol,
                  name: activity.SymbolProfile?.name,
                  quantity: activity.quantity,
                  unitPrice: activity.unitPrice,
                  currency: activity.SymbolProfile?.currency,
                  fee: activity.fee
                }));

              return {
                success: true,
                transactions: recentActivities,
                totalCount: activities.length
              };
            } catch (error) {
              return {
                success: false,
                error: `Failed to fetch transactions: ${error.message}`
              };
            }
          }
        })
      },
      // maxSteps is what makes this an agent, not a chain.
      // The LLM can call tools, see results, then decide to call
      // more tools or respond. Up to 5 iterations of the ReAct loop.
      maxSteps: 5
    });

    return {
      message: result.text,
      toolCalls: result.steps.flatMap((step) =>
        step.toolCalls.map((tc) => ({
          tool: tc.toolName,
          args: tc.args
        }))
      )
    };
  }
}
