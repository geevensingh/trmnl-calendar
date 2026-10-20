using CalendarAgenda;
using Microsoft.Azure.Functions.Worker.Builder;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;

var builder = FunctionsApplication.CreateBuilder(args);
builder.ConfigureFunctionsWebApplication();
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddHttpClient(Options.DefaultName, client =>
{
    client.Timeout = AgendaFunction.SourceAcquisitionTimeout;
}).ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler
{
    AllowAutoRedirect = false
}).RemoveAllLoggers();
builder.Build().Run();
